\set ON_ERROR_STOP on

-- Transport v3 (gated currency unit) regression for 20261004140000.
-- Run with:
--   -v transport_v3_fixture="$(jq -c . fixtures/quota-provider-v1/transport-v3.json)"
--   -v currency_fixture="$(jq -c . fixtures/quota-provider-v1/currency-v1.json)"

begin;

create temporary table quota_v3_fixture(name text primary key, payload jsonb not null)
  on commit drop;
insert into quota_v3_fixture values
  ('transport', :'transport_v3_fixture'::jsonb),
  ('currency', :'currency_fixture'::jsonb);
grant select on quota_v3_fixture to authenticated;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  ('77777777-7777-7777-7777-777777777777', 'quota-v3-a@example.invalid',
   pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()),
  ('88888888-8888-8888-8888-888888888888', 'quota-v3-b@example.invalid',
   pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now());

do $$
declare
  v_signature text;
  v_role text;
begin
  foreach v_signature in array array[
    'public.get_quota_snapshots_v3()',
    'public.upsert_quota_snapshots_v3(integer,bigint,jsonb)',
    'public.get_quota_snapshots_v2()',
    'public.upsert_quota_snapshots_v2(integer,bigint,jsonb)',
    'public.delete_quota_snapshot_provider_v2(integer,bigint,text,text,bigint)',
    'public.clear_quota_snapshots_v2(integer,bigint)',
    'public.get_quota_snapshots_v1()'
  ] loop
    if not pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'authenticated missing execute on %', v_signature;
    end if;
    foreach v_role in array array['public', 'anon', 'service_role'] loop
      if pg_catalog.has_function_privilege(v_role, v_signature, 'EXECUTE') then
        raise exception '% unexpectedly has execute on %', v_role, v_signature;
      end if;
    end loop;
  end loop;

  foreach v_signature in array array[
    'private.quota_snapshot_has_currency_v3(jsonb)',
    'private.validate_quota_snapshot_entries_v3(jsonb)',
    'private.quota_snapshot_payload_v3(uuid,bigint,bigint,timestamp with time zone,integer)',
    'private.quota_snapshot_payload_v2(uuid,bigint,bigint,timestamp with time zone)'
  ] loop
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if pg_catalog.has_function_privilege(v_role, v_signature, 'EXECUTE') then
        raise exception '% unexpectedly has execute on %', v_role, v_signature;
      end if;
    end loop;
  end loop;

  foreach v_signature in array array[
    'public.get_quota_snapshots_v3()',
    'public.upsert_quota_snapshots_v3(integer,bigint,jsonb)',
    'private.quota_snapshot_has_currency_v3(jsonb)',
    'private.validate_quota_snapshot_entries_v3(jsonb)',
    'private.quota_snapshot_payload_v3(uuid,bigint,bigint,timestamp with time zone,integer)',
    'private.quota_snapshot_payload_v2(uuid,bigint,bigint,timestamp with time zone)',
    'public.get_quota_snapshots_v1()'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure(v_signature)
        and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
    ) then
      raise exception '% does not have an empty fixed search_path', v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private'
      and c.relname in ('quota_snapshots', 'quota_snapshot_state')
      and not (c.relrowsecurity and c.relforcerowsecurity)
  ) then
    raise exception 'quota tables must enable and force RLS';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_table_privilege(v_role, 'private.quota_snapshots', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege(v_role, 'private.quota_snapshot_state', 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception '% unexpectedly has direct quota table privileges', v_role;
    end if;
  end loop;
end;
$$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_transport jsonb := (select payload from quota_v3_fixture where name = 'transport');
  v_currency jsonb := (select payload from quota_v3_fixture where name = 'currency');
  v_balance jsonb := v_transport #> '{v3UpsertRequest,p_providers,0,envelope}';
  v_codex jsonb := v_transport #> '{v3ReadResponse,providers,1}';
  v_case jsonb;
  v_read jsonb;
  v_result jsonb;
  v_epoch bigint;
  v_rejected boolean;
begin
  v_read := public.get_quota_snapshots_v3();
  v_epoch := (v_read ->> 'epoch')::bigint;
  if v_read ->> 'transportVersion' <> '3'
     or pg_catalog.jsonb_array_length(v_read -> 'providers') <> 0 then
    raise exception 'initial v3 read invalid: %', v_read;
  end if;

  v_result := public.upsert_quota_snapshots_v3(
    3, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_balance)
    )
  );
  if (v_result ->> 'upsertedProviderCount')::integer <> 1
     or v_result ->> 'transportVersion' <> '3'
     or pg_catalog.jsonb_array_length(v_result -> 'providers') <> 1 then
    raise exception 'v3 currency upsert failed: %', v_result;
  end if;

  v_result := public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_codex)
    )
  );
  if (v_result ->> 'upsertedProviderCount')::integer <> 1
     or pg_catalog.jsonb_array_length(v_result -> 'providers') <> 1
     or pg_catalog.jsonb_array_length(v_result -> 'providerStates') <> 1
     or v_result::text like '%"currency"%' then
    raise exception 'v2 upsert response leaked the currency envelope: %', v_result;
  end if;

  v_read := public.get_quota_snapshots_v3();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 2
     or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 2
     or v_read #>> '{providers,0,windows,0,currency}' <> 'CNY' then
    raise exception 'v3 read must return both providers: %', v_read;
  end if;

  v_read := public.get_quota_snapshots_v2();
  if v_read ->> 'transportVersion' <> '2'
     or pg_catalog.jsonb_array_length(v_read -> 'providers') <> 1
     or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 1
     or v_read #>> '{providers,0,providerId}' <> 'openai-codex-local'
     or v_read #>> '{providerStates,0,providerId}' <> 'openai-codex-local' then
    raise exception 'v2 projection must omit the currency envelope and its state: %', v_read;
  end if;

  v_read := public.get_quota_snapshots_v1();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 1
     or v_read::text like '%"currency"%' then
    raise exception 'v1 read leaked the currency envelope: %', v_read;
  end if;

  begin
    perform public.upsert_quota_snapshots_v2(
      2, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_balance)
      )
    );
    raise exception 'v2 upsert accepted a currency window';
  exception when sqlstate '22023' then
    if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
  end;

  begin
    perform public.replace_quota_snapshots_v1(1, v_epoch, pg_catalog.jsonb_build_array(v_balance));
    raise exception 'v1 replace accepted a currency window';
  exception when sqlstate '22023' then
    if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
  end;

  begin
    perform public.upsert_quota_snapshots_v3(
      2, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_balance)
      )
    );
    raise exception 'v3 upsert accepted transport version 2';
  exception when sqlstate '22023' then
    if sqlerrm <> 'quota_snapshot_unsupported_transport' then raise; end if;
  end;

  for v_case in
    select c.value from pg_catalog.jsonb_array_elements(v_currency -> 'cases') as c(value)
  loop
    v_rejected := false;
    begin
      perform public.upsert_quota_snapshots_v3(
        3, v_epoch, pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_case #> '{providers,0}')
        )
      );
    exception when sqlstate '22023' then
      if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
      v_rejected := true;
    end;
    if not v_rejected then
      raise exception 'v3 accepted invalid currency case %', v_case ->> 'name';
    end if;
  end loop;

  v_rejected := false;
  begin
    perform public.upsert_quota_snapshots_v3(
      3, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'generation', 0,
          'envelope', v_currency #> '{unknownUnitCases,0,provider}'
        )
      )
    );
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'v3 writer must stay strict about unknown units';
  end if;

  v_result := public.delete_quota_snapshot_provider_v2(
    2, v_epoch, 'balance-deepseek', 'api-organization', 0
  );
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_result -> 'providerStates') as s(value)
    where s.value ->> 'providerId' = 'balance-deepseek'
      and (s.value ->> 'deleted')::boolean
      and (s.value ->> 'generation')::bigint = 1
  ) then
    raise exception 'v2 delete must tombstone the currency provider: %', v_result;
  end if;
  v_read := public.get_quota_snapshots_v3();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 1
     or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 2 then
    raise exception 'v3 read after delete invalid: %', v_read;
  end if;
end;
$$;

select pg_catalog.set_config(
  'request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true
);

do $$
declare
  v_read jsonb := public.get_quota_snapshots_v3();
begin
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 0
     or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 0 then
    raise exception 'v3 read crossed owners: %', v_read;
  end if;
  begin
    perform 1 from private.quota_snapshots;
    raise exception 'authenticated read the private quota table directly';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

explain (costs, format text)
select s.envelope
from private.quota_snapshots s
where s.user_id = '77777777-7777-7777-7777-777777777777'::uuid
  and s.deleted_at is null
  and not private.quota_snapshot_has_currency_v3(s.envelope)
order by s.provider_id, s.scope;

rollback;
