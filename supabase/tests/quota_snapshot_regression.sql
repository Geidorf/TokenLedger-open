\set ON_ERROR_STOP on

-- This file freezes the historical v6 transport-v1 replacement/TTL behavior.
-- Once v7 is present those semantics are intentionally superseded; current
-- databases run quota_snapshot_v2_regression.sql instead.
select (pg_catalog.to_regprocedure('public.get_quota_snapshots_v2()') is not null)::text
  as quota_v2_active \gset
\if :quota_v2_active
\echo 'quota_snapshot_regression.sql: v6 historical suite skipped because transport v2 is active'
\quit
\endif

-- Required psql variables are supplied from the repository fixtures with
-- `-v name="$(jq -c . path)"`; no fixture payload is copied into this file.
begin;

create temporary table quota_fixture (
  name text primary key,
  payload jsonb not null
) on commit drop;

insert into quota_fixture (name, payload) values
  ('complete', :'complete_fixture'::jsonb),
  ('states', :'states_fixture'::jsonb),
  ('invalid', :'invalid_fixture'::jsonb),
  ('transport', :'transport_fixture'::jsonb);

grant select on quota_fixture to authenticated;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '33333333-3333-3333-3333-333333333333',
    'quota-user-one@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  ),
  (
    '44444444-4444-4444-4444-444444444444',
    'quota-user-two@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  );

create or replace function pg_temp.expect_quota_error(
  p_transport_version integer,
  p_epoch bigint,
  p_payload jsonb,
  p_message text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  begin
    perform public.replace_quota_snapshots_v1(
      p_transport_version, p_epoch, p_payload
    );
    raise exception 'expected quota error %, call succeeded', p_message;
  exception
    when invalid_parameter_value then
      if sqlerrm <> p_message then
        raise exception 'expected quota error %, got %', p_message, sqlerrm;
      end if;
  end;
end;
$$;

do $$
declare
  v_role text;
  v_privilege text;
  v_signature text;
  v_transport jsonb;
begin
  select payload into v_transport from quota_fixture where name = 'transport';
  if (v_transport #>> '{replaceExpected,producerMaxCompactUtf8Bytes}')::integer <> 61440
     or (v_transport #>> '{replaceExpected,serverMaxJsonbTextUtf8Bytes}')::integer <> 65536 then
    raise exception 'transport byte budgets do not match the frozen fixture';
  end if;
  if pg_catalog.jsonb_array_length(
    (select payload -> 'cases' from quota_fixture where name = 'invalid')
  ) <> 11 then
    raise exception 'invalid fixture must expose all 11 frozen cases';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private'
      and c.relname in ('quota_snapshot_state', 'quota_snapshots')
      and c.relrowsecurity and c.relforcerowsecurity
    group by n.nspname
    having pg_catalog.count(*) = 2
  ) then
    raise exception 'quota tables must enable and force RLS';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private'
      and c.relname in ('quota_snapshot_state', 'quota_snapshots')
      and p.polcmd <> 'r'
  ) then
    raise exception 'quota tables unexpectedly expose a write RLS policy';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_schema_privilege(v_role, 'private', 'usage') then
      raise exception '% unexpectedly has private schema USAGE', v_role;
    end if;
    foreach v_privilege in array array['select', 'insert', 'update', 'delete'] loop
      if pg_catalog.has_table_privilege(
        v_role, 'private.quota_snapshot_state', v_privilege
      ) or pg_catalog.has_table_privilege(
        v_role, 'private.quota_snapshots', v_privilege
      ) then
        raise exception '% unexpectedly has quota table %', v_role, v_privilege;
      end if;
    end loop;
  end loop;

  foreach v_signature in array array[
    'public.replace_quota_snapshots_v1(integer,bigint,jsonb)',
    'public.get_quota_snapshots_v1()',
    'public.clear_quota_snapshots_v1(integer)'
  ] loop
    if not pg_catalog.has_function_privilege('authenticated', v_signature, 'execute') then
      raise exception 'authenticated is missing % EXECUTE', v_signature;
    end if;
    if pg_catalog.has_function_privilege('anon', v_signature, 'execute')
       or pg_catalog.has_function_privilege('service_role', v_signature, 'execute') then
      raise exception 'anon/service_role unexpectedly has % EXECUTE', v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'replace_quota_snapshots_v1',
        'get_quota_snapshots_v1',
        'clear_quota_snapshots_v1'
      )
      and (
        not p.prosecdef
        or not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=""'])
      )
  ) then
    raise exception 'quota RPCs must be SECURITY DEFINER with empty search_path';
  end if;
  if not exists (
    select 1 from cron.job
    where jobname = 'tokenledger-quota-snapshot-hourly-purge'
      and schedule = '0 * * * *'
      and active
      and command = 'select private.purge_expired_quota_snapshots_v1();'
  ) then
    raise exception 'hourly physical purge schedule is missing or malformed';
  end if;
end;
$$;

-- The owner can initialize and replace a complete valid fixture.
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_epoch bigint;
  v_result jsonb;
  v_read jsonb;
  v_complete jsonb;
begin
  select payload into v_complete from quota_fixture where name = 'complete';
  v_result := public.get_quota_snapshots_v1();
  v_epoch := (v_result ->> 'epoch')::bigint;
  v_result := public.replace_quota_snapshots_v1(
    1, v_epoch, v_complete -> 'providers'
  );
  if v_result ->> 'status' <> 'ok'
     or (v_result ->> 'replacedProviderCount')::integer <> 3 then
    raise exception 'complete fixture replace failed: %', v_result;
  end if;
  v_read := public.get_quota_snapshots_v1();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 3
     or v_read ? 'user_id' or v_read ? 'userId' then
    raise exception 'complete fixture read shape is invalid: %', v_read;
  end if;
end;
$$;

-- A second authenticated owner sees an independent empty state.
reset role;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_read jsonb := public.get_quota_snapshots_v1();
begin
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 0 then
    raise exception 'owner isolation failed: %', v_read;
  end if;
end;
$$;

-- Every states fixture is consumed: one cloud-safe provider is accepted;
-- action and unknown-field projections are rejected without mutation.
reset role;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_states jsonb;
  v_case jsonb;
  v_epoch bigint;
  v_before jsonb;
  v_after jsonb;
begin
  select payload into v_states from quota_fixture where name = 'states';
  if v_states #>> '{absenceCase,outcome}' <> 'unavailable-not-zero' then
    raise exception 'old-response absence semantics drifted';
  end if;
  for v_case in
    select c.value from pg_catalog.jsonb_array_elements(v_states -> 'envelopeCases') c(value)
  loop
    v_before := public.get_quota_snapshots_v1();
    v_epoch := (v_before ->> 'epoch')::bigint;
    if v_case ->> 'syncOutcome' = 'valid' then
      perform public.replace_quota_snapshots_v1(
        1, v_epoch, pg_catalog.jsonb_build_array(v_case -> 'provider')
      );
    else
      perform pg_temp.expect_quota_error(
        1,
        v_epoch,
        pg_catalog.jsonb_build_array(v_case -> 'provider'),
        'quota_snapshot_invalid_payload'
      );
      v_after := public.get_quota_snapshots_v1();
      if v_after -> 'providers' <> v_before -> 'providers'
         or v_after ->> 'revision' <> v_before ->> 'revision' then
        raise exception 'rejected states case mutated storage: %', v_case ->> 'name';
      end if;
    end if;
  end loop;
end;
$$;

-- All 11 invalid fixture cases must fail closed and remain atomic.
do $$
declare
  v_invalid jsonb;
  v_case jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  select payload into v_invalid from quota_fixture where name = 'invalid';
  for v_case in
    select c.value from pg_catalog.jsonb_array_elements(v_invalid -> 'cases') c(value)
  loop
    v_before := public.get_quota_snapshots_v1();
    perform pg_temp.expect_quota_error(
      1,
      (v_before ->> 'epoch')::bigint,
      v_case -> 'providers',
      'quota_snapshot_invalid_payload'
    );
    v_after := public.get_quota_snapshots_v1();
    if v_after -> 'providers' <> v_before -> 'providers'
       or v_after ->> 'revision' <> v_before ->> 'revision' then
      raise exception 'invalid fixture mutated storage: %', v_case ->> 'name';
    end if;
  end loop;
end;
$$;

-- An authenticated role without an authenticated user gets the stable 42501
-- identity error rather than input echo or an internal cast failure.
reset role;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform public.get_quota_snapshots_v1();
    raise exception 'missing identity unexpectedly succeeded';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'quota_snapshot_identity_required' then
        raise exception 'identity error drifted: %', sqlerrm;
      end if;
  end;
end;
$$;

-- Exercise the exact transport request/response, both clear/replace orders,
-- the authoritative 64 KiB boundary, collection limits, and stable errors.
reset role;
delete from private.quota_snapshots
where user_id = '33333333-3333-3333-3333-333333333333';
update private.quota_snapshot_state
set epoch = 7, revision = 11
where user_id = '33333333-3333-3333-3333-333333333333';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_transport jsonb;
  v_request jsonb;
  v_expected jsonb;
  v_result jsonb;
  v_read jsonb;
  v_before jsonb;
  v_after jsonb;
  v_clear jsonb;
  v_base jsonb;
  v_payload jsonb;
  v_window jsonb;
  v_length integer;
begin
  select payload into v_transport from quota_fixture where name = 'transport';
  v_request := v_transport -> 'replaceRequest';
  v_expected := v_transport -> 'replaceExpected';
  v_result := public.replace_quota_snapshots_v1(
    (v_request ->> 'p_transport_version')::integer,
    (v_request ->> 'p_epoch')::bigint,
    v_request -> 'p_providers'
  );
  if v_result - 'generatedAt' <> pg_catalog.jsonb_build_object(
    'status', v_expected ->> 'status',
    'transportVersion', (v_expected ->> 'transportVersion')::integer,
    'epoch', (v_expected ->> 'epoch')::bigint,
    'revision', (v_expected ->> 'revision')::bigint,
    'replacedProviderCount', (v_expected ->> 'replacedProviderCount')::integer
  ) then
    raise exception 'replace response drifted: %', v_result;
  end if;
  v_read := public.get_quota_snapshots_v1();
  if v_read -> 'providers' <> v_transport #> '{readResponse,providers}'
     or v_read ->> 'epoch' <> v_transport #>> '{readResponse,epoch}'
     or v_read ->> 'revision' <> v_transport #>> '{readResponse,revision}' then
    raise exception 'read response drifted: %', v_read;
  end if;

  v_clear := public.clear_quota_snapshots_v1(
    (v_transport #>> '{clearRequest,p_transport_version}')::integer
  );
  if v_clear - 'generatedAt' <> (v_transport -> 'clearResponse') - 'generatedAt' then
    raise exception 'clear response drifted: %', v_clear;
  end if;
  if pg_catalog.jsonb_array_length(
    public.get_quota_snapshots_v1() -> 'providers'
  ) <> 0 then
    raise exception 'replace-before-clear race did not end empty';
  end if;
  perform pg_temp.expect_quota_error(
    1, 7, v_request -> 'p_providers', 'quota_snapshot_stale_epoch'
  );
  if pg_catalog.jsonb_array_length(
    public.get_quota_snapshots_v1() -> 'providers'
  ) <> 0 then
    raise exception 'clear-before-late-replace race did not end empty';
  end if;

  perform pg_temp.expect_quota_error(
    2, 8, '[]'::jsonb, 'quota_snapshot_unsupported_transport'
  );
  begin
    perform public.clear_quota_snapshots_v1(2);
    raise exception 'unsupported clear transport unexpectedly succeeded';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'quota_snapshot_unsupported_transport' then
        raise exception 'clear transport error drifted: %', sqlerrm;
      end if;
  end;
  perform pg_temp.expect_quota_error(
    1, -1, '[]'::jsonb, 'quota_snapshot_invalid_epoch'
  );

  -- Exactly 64 KiB reaches structural validation; the next byte is rejected
  -- by the authoritative server budget before field validation.
  v_base := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('padding', ''));
  v_payload := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'padding', pg_catalog.repeat('x', 65536 - pg_catalog.octet_length(v_base::text))
  ));
  v_length := pg_catalog.octet_length(v_payload::text);
  if v_length <> 65536 then
    raise exception 'failed to construct exact 64 KiB fixture: %', v_length;
  end if;
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );
  v_payload := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'padding', pg_catalog.repeat('x', 65537 - pg_catalog.octet_length(v_base::text))
  ));
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_payload_too_large'
  );

  perform pg_temp.expect_quota_error(
    1, 8, '{}'::jsonb, 'quota_snapshot_invalid_payload'
  );
  perform pg_temp.expect_quota_error(
    1, 8, '[1]'::jsonb, 'quota_snapshot_invalid_payload'
  );
  v_base := v_request #> '{p_providers,0}';
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(v_base, '{windows}', '[1]'::jsonb)
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );

  -- A near-valid non-manual envelope cannot claim manual capability. The
  -- rejected full replace must preserve both providers and revision.
  v_before := public.get_quota_snapshots_v1();
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(v_base, '{capability}', '"manual"'::jsonb)
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );
  v_after := public.get_quota_snapshots_v1();
  if v_after -> 'providers' <> v_before -> 'providers'
     or v_after ->> 'revision' <> v_before ->> 'revision' then
    raise exception 'manual capability mismatch mutated storage';
  end if;

  -- The exact stable-ID/general-string maxima are accepted; the next byte,
  -- unregistered reason codes, and non-allowlisted sources fail closed.
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          v_base,
          '{providerId}',
          pg_catalog.to_jsonb(pg_catalog.repeat('p', 128))
        ),
        '{windows,0,providerId}',
        pg_catalog.to_jsonb(pg_catalog.repeat('p', 128))
      ),
      '{displayName}',
      pg_catalog.to_jsonb(pg_catalog.repeat('d', 512))
    )
  );
  v_result := public.replace_quota_snapshots_v1(1, 8, v_payload);
  if (v_result ->> 'replacedProviderCount')::integer <> 1 then
    raise exception 'exact string limits were not accepted: %', v_result;
  end if;

  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        v_base,
        '{providerId}',
        pg_catalog.to_jsonb(pg_catalog.repeat('p', 129))
      ),
      '{windows,0,providerId}',
      pg_catalog.to_jsonb(pg_catalog.repeat('p', 129))
    )
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(v_base, '{reasonCode}', '"not_registered"'::jsonb)
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(
      v_base, '{windows,0,source}', '"scraped-cookie"'::jsonb
    )
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );

  v_base := v_request #> '{p_providers,1}';
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(
      v_base, '{providerId}', pg_catalog.to_jsonb('provider-' || g::text)
    ) order by g
  ) into v_payload
  from pg_catalog.generate_series(1, 8) g;
  v_result := public.replace_quota_snapshots_v1(1, 8, v_payload);
  if (v_result ->> 'replacedProviderCount')::integer <> 8 then
    raise exception 'exact provider count limit was not accepted: %', v_result;
  end if;
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(
      v_base, '{providerId}', pg_catalog.to_jsonb('provider-' || g::text)
    ) order by g
  ) into v_payload
  from pg_catalog.generate_series(1, 9) g;
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );

  v_base := v_request #> '{p_providers,0}';
  v_window := v_base #> '{windows,0}';
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(
      v_window, '{windowId}', pg_catalog.to_jsonb('window-' || g::text)
    ) order by g
  ) into v_payload
  from pg_catalog.generate_series(1, 16) g;
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(v_base, '{windows}', v_payload)
  );
  v_result := public.replace_quota_snapshots_v1(1, 8, v_payload);
  if (v_result ->> 'replacedProviderCount')::integer <> 1 then
    raise exception 'exact window count limit was not accepted: %', v_result;
  end if;
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(
      v_window, '{windowId}', pg_catalog.to_jsonb('window-' || g::text)
    ) order by g
  ) into v_payload
  from pg_catalog.generate_series(1, 17) g;
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(v_base, '{windows}', v_payload)
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );

  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(v_base, '{displayName}', pg_catalog.to_jsonb(pg_catalog.repeat('界', 171)))
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );
  v_payload := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(
      v_base, '{windows,0,used}', '1e400'::jsonb
    )
  );
  perform pg_temp.expect_quota_error(
    1, 8, v_payload, 'quota_snapshot_invalid_payload'
  );
end;
$$;

-- Recreate rows for both owners so read-time cleanup and the privileged purge
-- exercise independent physical deletion paths.
do $$
declare
  v_epoch bigint;
  v_transport jsonb;
begin
  select payload into v_transport from quota_fixture where name = 'transport';
  v_epoch := (public.get_quota_snapshots_v1() ->> 'epoch')::bigint;
  perform public.replace_quota_snapshots_v1(
    1, v_epoch, v_transport #> '{replaceRequest,p_providers}'
  );
end;
$$;

reset role;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  v_epoch bigint;
  v_transport jsonb;
begin
  select payload into v_transport from quota_fixture where name = 'transport';
  v_epoch := (public.get_quota_snapshots_v1() ->> 'epoch')::bigint;
  perform public.replace_quota_snapshots_v1(
    1, v_epoch, pg_catalog.jsonb_build_array(
      v_transport #> '{replaceRequest,p_providers,0}'
    )
  );
end;
$$;

-- TTL reads delete the caller's expired rows. The privileged purge removes
-- an inactive owner's rows, while cron metadata proves the <=25h schedule.
reset role;
update private.quota_snapshots
set updated_at = '2000-01-01 00:00:00+00'::timestamptz,
    expires_at = '2000-01-02 00:00:00+00'::timestamptz
where user_id in (
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
select public.get_quota_snapshots_v1();

reset role;
do $$
declare
  v_purged bigint;
begin
  if exists (
    select 1 from private.quota_snapshots
    where user_id = '33333333-3333-3333-3333-333333333333'
      and expires_at <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'get did not physically delete the expired owner row';
  end if;
  v_purged := private.purge_expired_quota_snapshots_v1();
  if v_purged <> 1 or exists (
    select 1 from private.quota_snapshots
    where user_id = '44444444-4444-4444-4444-444444444444'
  ) then
    raise exception 'privileged purge did not delete the inactive owner row: %', v_purged;
  end if;
end;
$$;

-- Temporarily grant SELECT inside this rolled-back transaction to prove the
-- RLS predicates isolate both owners; production grants remain absent.
grant usage on schema private to authenticated;
grant select on private.quota_snapshot_state, private.quota_snapshots to authenticated;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true
);
do $$
begin
  if (select pg_catalog.count(*) from private.quota_snapshot_state) <> 1 then
    raise exception 'RLS did not isolate user one state';
  end if;
end;
$$;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true
);
do $$
begin
  if (select pg_catalog.count(*) from private.quota_snapshot_state) <> 1 then
    raise exception 'RLS did not isolate user two state';
  end if;
end;
$$;

reset role;
revoke all on private.quota_snapshot_state, private.quota_snapshots from authenticated;
revoke all on schema private from authenticated;

-- The product path is unavailable to anon and service_role even though both
-- roles can reach the public schema.
set local role anon;
do $$
begin
  begin
    perform public.get_quota_snapshots_v1();
    raise exception 'anon quota RPC unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
set local role service_role;
do $$
begin
  begin
    perform public.get_quota_snapshots_v1();
    raise exception 'service_role quota RPC unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
