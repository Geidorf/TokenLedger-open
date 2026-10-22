\set ON_ERROR_STOP on

-- Balance reason code regression for 20261004150000 (T10.288).
-- Run with:
--   -v balance_fixture="$(jq -c . fixtures/quota-provider-v1/balance-v1.json)"

begin;

create temporary table quota_balance_fixture(payload jsonb not null) on commit drop;
insert into quota_balance_fixture values (:'balance_fixture'::jsonb);
grant select on quota_balance_fixture to authenticated;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '99999999-9999-9999-9999-999999999999', 'quota-balance@example.invalid',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
);

do $$
declare
  v_role text;
begin
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_function_privilege(
      v_role, 'private.quota_snapshot_reason_valid_v1(text)', 'EXECUTE'
    ) then
      raise exception '% unexpectedly has execute on quota_snapshot_reason_valid_v1', v_role;
    end if;
  end loop;
  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.quota_snapshot_reason_valid_v1(text)')
      and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'quota_snapshot_reason_valid_v1 lost its empty fixed search_path';
  end if;
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

  if not (
    private.quota_snapshot_reason_valid_v1('balance_unavailable')
    and private.quota_snapshot_reason_valid_v1('api_key_required')
    and private.quota_snapshot_reason_valid_v1('secure_storage_unavailable')
    and private.quota_snapshot_reason_valid_v1('upstream_unavailable')
  ) then
    raise exception 'balance reason codes are not registered';
  end if;
  if private.quota_snapshot_reason_valid_v1('balance_unavailable_x')
     or private.quota_snapshot_reason_valid_v1('experimental_consent_required') then
    raise exception 'unregistered reason codes must stay rejected';
  end if;
end;
$$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_fixture jsonb := (select payload from quota_balance_fixture);
  v_moonshot jsonb := v_fixture #> '{providers,0,envelope}';
  v_stale jsonb;
  v_reason text;
  v_minute integer := 0;
  v_read jsonb;
  v_result jsonb;
  v_epoch bigint;
  v_rejected boolean;
begin
  if v_moonshot ->> 'providerId' <> 'balance-moonshot'
     or v_moonshot #>> '{windows,0,unit}' <> 'currency' then
    raise exception 'balance fixture changed shape: %', v_moonshot;
  end if;
  v_read := public.get_quota_snapshots_v3();
  v_epoch := (v_read ->> 'epoch')::bigint;

  foreach v_reason in array array[
    'balance_unavailable', 'api_key_required', 'secure_storage_unavailable', 'rate_limited'
  ] loop
    v_minute := v_minute + 1;
    v_stale := v_moonshot
      || pg_catalog.jsonb_build_object('status', 'stale', 'reasonCode', v_reason);
    v_stale := pg_catalog.jsonb_set(
      v_stale, '{windows,0}',
      (v_stale #> '{windows,0}') || pg_catalog.jsonb_build_object(
        'status', 'stale',
        'reasonCode', v_reason,
        'observedAt', pg_catalog.format('2026-10-04T12:%s:00+08:00', pg_catalog.lpad(v_minute::text, 2, '0'))
      )
    );
    v_result := public.upsert_quota_snapshots_v3(
      3, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_stale)
      )
    );
    if (v_result ->> 'upsertedProviderCount')::integer <> 1 then
      raise exception 'stale balance with % was not upserted: %', v_reason, v_result;
    end if;
  end loop;

  v_read := public.get_quota_snapshots_v3();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 1
     or v_read #>> '{providers,0,reasonCode}' <> 'rate_limited'
     or v_read #>> '{providers,0,windows,0,currency}' <> 'CNY' then
    raise exception 'v3 read must return the latest stale balance: %', v_read;
  end if;

  v_read := public.get_quota_snapshots_v2();
  if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 0
     or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 0
     or v_read::text like '%"currency"%' then
    raise exception 'v2 projection must still omit currency envelopes: %', v_read;
  end if;

  v_rejected := false;
  begin
    perform public.upsert_quota_snapshots_v3(
      3, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'generation', 0,
          'envelope', pg_catalog.jsonb_set(
            v_stale || pg_catalog.jsonb_build_object('reasonCode', 'balance_unavailable_x'),
            '{windows,0,observedAt}', '"2026-10-04T12:30:00+08:00"'::jsonb
          )
        )
      )
    );
  exception when sqlstate '22023' then
    if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'v3 accepted an unregistered reason code';
  end if;

  begin
    perform public.upsert_quota_snapshots_v2(
      2, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_stale)
      )
    );
    raise exception 'v2 upsert accepted a currency window';
  exception when sqlstate '22023' then
    if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
  end;
end;
$$;

reset role;

rollback;
