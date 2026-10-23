\set ON_ERROR_STOP on

begin;

do $$
declare
  v_signature text;
  v_function text;
begin
  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ) then
    raise exception 'one or more public tables do not have RLS enabled';
  end if;

  if not has_table_privilege('authenticated', 'public.sync_state', 'select') then
    raise exception 'authenticated lost sync_state read access';
  end if;
  if has_table_privilege('anon', 'public.sync_state', 'select')
     or has_table_privilege('authenticated', 'public.sync_state', 'insert')
     or has_table_privilege('authenticated', 'public.sync_state', 'update')
     or has_table_privilege('authenticated', 'public.sync_state', 'delete') then
    raise exception 'sync_state Data API privileges are broader than read-only authenticated access';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'sync_state'
      and policyname = 'sync_state_select_own'
      and cmd = 'SELECT'
      and 'authenticated' = any(roles)
  ) then
    raise exception 'sync_state authenticated SELECT policy disappeared';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'sync_state'
      and policyname = 'sync_state_modify_blocked'
  ) then
    raise exception 'redundant sync_state_modify_blocked policy still exists';
  end if;

  foreach v_function in array array[
    'public.set_updated_at()',
    'private.tokenledger_ascii_trim_v2(text)',
    'private.tokenledger_search_match_v2(text,text,text,text,text)'
  ]
  loop
    if not exists (
      select 1
      from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure(v_function)
        and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
    ) then
      raise exception '% does not have an empty fixed search_path', v_function;
    end if;
  end loop;

  -- Public and legacy call signatures are release compatibility boundaries.
  foreach v_signature in array array[
    'public.request_refresh()',
    'public.get_dashboard_stats(uuid,text,text,text)',
    'public.get_yesterday_stats(uuid,text,text)',
    'public.get_usage_details_v1(uuid,text,text,text,text,text,text,integer)',
    'public.get_usage_comparison_v1(uuid,text,text,text,text,text)',
    'public.get_usage_entity_dashboard_v1(uuid,text,text,text,text,text)',
    'public.get_dashboard_stats_v2(uuid,jsonb)',
    'public.get_usage_comparison_v2(uuid,jsonb)',
    'public.get_usage_details_v2(uuid,jsonb,text,integer)',
    'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)',
    'public.replace_quota_snapshots_v1(integer,bigint,jsonb)',
    'public.get_quota_snapshots_v1()',
    'public.clear_quota_snapshots_v1(integer)',
    'public.get_quota_snapshots_v2()',
    'public.upsert_quota_snapshots_v2(integer,bigint,jsonb)',
    'public.delete_quota_snapshot_provider_v2(integer,bigint,text,text,bigint)',
    'public.clear_quota_snapshots_v2(integer,bigint)',
    'public.get_quota_snapshots_v3()',
    'public.upsert_quota_snapshots_v3(integer,bigint,jsonb)',
    'public.publish_routing_snapshot_v1(text,jsonb)',
    'public.get_routing_snapshots_v1()',
    'public.clear_routing_snapshot_v1(text)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null then
      raise exception 'release compatibility signature disappeared: %', v_signature;
    end if;
  end loop;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

-- Read access is intentionally retained.
select id, is_dirty, dirty_generation, refreshed_generation, last_refreshed_at
from public.sync_state
where id = 1;

-- A direct client write must fail at the privilege/RLS boundary. The
-- SECURITY DEFINER refresh/trigger path is covered by stats_v2_regression.sql.
do $$
begin
  begin
    update public.sync_state set is_dirty = false where id = 1;
    raise exception 'authenticated direct sync_state write unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;

-- Keep reproducible plan evidence in the release gate. The full 100k-row
-- ANALYZE workload and latency evidence remain in stats_v2_regression.sql.
explain (costs, format text)
select id, timestamp
from public.token_logs
where user_id = '11111111-1111-1111-1111-111111111111'
  and machine_id = 'release-fixture-machine'
  and tool = 'Codex'
  and model = 'gpt-5'
order by timestamp desc, id desc
limit 51;

explain (costs, format text)
select id, timestamp
from public.token_logs
where user_id = '11111111-1111-1111-1111-111111111111'
  and timestamp >= '2026-01-01 00:00:00'
order by timestamp desc, id desc
limit 51;

rollback;
