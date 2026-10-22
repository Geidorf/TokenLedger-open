\set ON_ERROR_STOP on

begin;

create temporary table quota_v2_fixture(payload jsonb not null) on commit drop;
insert into quota_v2_fixture values (:'transport_v2_fixture'::jsonb);
grant select on quota_v2_fixture to authenticated;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  ('55555555-5555-5555-5555-555555555555', 'quota-v2-a@example.invalid',
   pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()),
  ('66666666-6666-6666-6666-666666666666', 'quota-v2-b@example.invalid',
   pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now());

do $$
declare
  v_signature text;
  v_role text;
begin
  foreach v_signature in array array[
    'public.get_quota_snapshots_v2()',
    'public.upsert_quota_snapshots_v2(integer,bigint,jsonb)',
    'public.delete_quota_snapshot_provider_v2(integer,bigint,text,text,bigint)',
    'public.clear_quota_snapshots_v2(integer,bigint)'
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
  if exists (
    select 1 from cron.job where jobname = 'tokenledger-quota-snapshot-hourly-purge'
  ) then
    raise exception 'legacy quota purge cron must be unscheduled';
  end if;
end;
$$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_fixture jsonb := (select payload from quota_v2_fixture limit 1);
  v_codex jsonb := v_fixture #> '{upsertRequest,p_providers,0,envelope}';
  v_claude jsonb;
  v_epoch bigint;
  v_result jsonb;
  v_read jsonb;
  v_newer jsonb;
  v_older jsonb;
  v_equal jsonb;
  v_deleted jsonb;
  v_generation bigint;
begin
  v_read := public.get_quota_snapshots_v2();
  v_epoch := (v_read ->> 'epoch')::bigint;
  if v_read ->> 'transportVersion' <> '2'
     or pg_catalog.jsonb_array_length(v_read -> 'providers') <> 0 then
    raise exception 'initial v2 read invalid: %', v_read;
  end if;

  v_result := public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_codex)
    )
  );
  if (v_result ->> 'upsertedProviderCount')::integer <> 1 then
    raise exception 'initial upsert failed: %', v_result;
  end if;

  v_claude := pg_catalog.jsonb_set(v_codex, '{providerId}', '"anthropic-claude-consumer"');
  v_claude := pg_catalog.jsonb_set(v_claude, '{displayName}', '"Claude"');
  v_claude := pg_catalog.jsonb_set(v_claude, '{windows,0,providerId}', '"anthropic-claude-consumer"');
  v_claude := pg_catalog.jsonb_set(v_claude, '{windows,0,windowId}', '"claude:primary"');
  perform public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_claude)
    )
  );

  -- Omitting Claude from Codex's next upload must never delete it.
  v_newer := pg_catalog.jsonb_set(v_codex, '{windows,0,observedAt}', '"2026-07-15T09:00:00+08:00"');
  v_newer := pg_catalog.jsonb_set(v_newer, '{windows,0,fetchedAt}', '"2026-07-15T09:00:01+08:00"');
  v_newer := pg_catalog.jsonb_set(v_newer, '{windows,0,used}', '50');
  v_newer := pg_catalog.jsonb_set(v_newer, '{windows,0,remaining}', '50');
  perform public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_newer)
    )
  );
  v_read := public.get_quota_snapshots_v2();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 2 then
    raise exception 'omitted Provider was deleted: %', v_read;
  end if;

  -- Older source observation is ignored even if received later.
  v_older := pg_catalog.jsonb_set(v_codex, '{windows,0,observedAt}', '"2026-07-15T08:00:00+08:00"');
  v_older := pg_catalog.jsonb_set(v_older, '{windows,0,used}', '10');
  v_older := pg_catalog.jsonb_set(v_older, '{windows,0,remaining}', '90');
  v_result := public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_older)
    )
  );
  if (v_result ->> 'ignoredProviderCount')::integer <> 1
     or (select (p.value #>> '{windows,0,used}')::numeric
         from pg_catalog.jsonb_array_elements(v_result -> 'providers') p(value)
         where p.value ->> 'providerId' = 'openai-codex-local') <> 50 then
    raise exception 'older observation overwrote latest: %', v_result;
  end if;

  -- Equal source time is accepted; later server receive time is the tie-break.
  v_equal := pg_catalog.jsonb_set(v_newer, '{windows,0,used}', '55');
  v_equal := pg_catalog.jsonb_set(v_equal, '{windows,0,remaining}', '45');
  v_result := public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_equal)
    )
  );
  if (select (p.value #>> '{windows,0,used}')::numeric
      from pg_catalog.jsonb_array_elements(v_result -> 'providers') p(value)
      where p.value ->> 'providerId' = 'openai-codex-local') <> 55 then
    raise exception 'equal-observed receive tie-break failed: %', v_result;
  end if;

  -- An installed v1 desktop remains additive after migration and cannot
  -- delete a Provider merely by omitting it from the legacy request.
  perform public.replace_quota_snapshots_v1(
    1, v_epoch, pg_catalog.jsonb_build_array(v_equal)
  );
  v_read := public.get_quota_snapshots_v2();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 2
     or public.get_quota_snapshots_v1() ->> 'transportVersion' <> '1' then
    raise exception 'legacy v1 compatibility failed: %', v_read;
  end if;

  begin
    perform public.upsert_quota_snapshots_v2(
      2, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'generation', 0,
          'envelope', pg_catalog.jsonb_set(v_codex, '{status}', '"error"')
        )
      )
    );
    raise exception 'error envelope unexpectedly accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
  end;

  v_deleted := public.delete_quota_snapshot_provider_v2(
    2, v_epoch, 'openai-codex-local', 'consumer-subscription', 0
  );
  v_generation := (v_deleted ->> 'providerGeneration')::bigint;
  if v_generation <> 1
     or pg_catalog.jsonb_array_length(v_deleted -> 'providers') <> 1 then
    raise exception 'provider delete failed: %', v_deleted;
  end if;

  -- Both the in-flight old generation and an acknowledged but pre-delete
  -- observation are unable to recreate the deleted Provider.
  v_result := public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_newer)
    )
  );
  if (v_result ->> 'ignoredProviderCount')::integer <> 1 then
    raise exception 'old generation was not ignored: %', v_result;
  end if;
  v_result := public.upsert_quota_snapshots_v2(
    2, v_epoch, pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('generation', 1, 'envelope', v_newer)
    )
  );
  if (v_result ->> 'ignoredProviderCount')::integer <> 1 then
    raise exception 'pre-delete observation recreated tombstone: %', v_result;
  end if;
end;
$$;

-- There is no age-based read or purge. Old rows remain visible and clients
-- are responsible for displaying their window freshness honestly.
reset role;
update private.quota_snapshots
set received_at = pg_catalog.clock_timestamp() - interval '10 years',
    updated_at = pg_catalog.clock_timestamp() - interval '10 years'
where user_id = '55555555-5555-5555-5555-555555555555'
  and provider_id = 'anthropic-claude-consumer';
do $$
begin
  if private.purge_expired_quota_snapshots_v1() <> 0 then
    raise exception 'legacy purge removed durable rows';
  end if;
end;
$$;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  v_epoch bigint;
  v_result jsonb;
  v_read jsonb;
begin
  v_read := public.get_quota_snapshots_v2();
  v_epoch := (v_read ->> 'epoch')::bigint;
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 1 then
    raise exception 'durable retention failed: %', v_read;
  end if;

  v_result := public.clear_quota_snapshots_v2(2, v_epoch);
  if (v_result ->> 'epoch')::bigint <> v_epoch + 1
     or pg_catalog.jsonb_array_length(v_result -> 'providers') <> 0 then
    raise exception 'global clear failed: %', v_result;
  end if;
  begin
    perform public.upsert_quota_snapshots_v2(2, v_epoch, '[]'::jsonb);
    raise exception 'stale epoch unexpectedly accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'quota_snapshot_stale_epoch' then raise; end if;
  end;
end;
$$;

-- A second owner never sees A's durable rows or tombstones.
reset role;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare v_read jsonb := public.get_quota_snapshots_v2();
begin
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 0
     or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 0 then
    raise exception 'owner isolation failed: %', v_read;
  end if;
end;
$$;

rollback;
