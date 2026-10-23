\set ON_ERROR_STOP on

-- routing-snapshot-v1: owner-scoped live routing snapshot relay.
begin;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '7a5e0000-0000-4000-8000-000000000001',
    'routing-snapshot@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  ),
  (
    '7a5e0000-0000-4000-8000-000000000002',
    'routing-snapshot-other@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  );

do $schema$
begin
  if pg_catalog.to_regclass('private.routing_snapshots') is null then
    raise exception 'private.routing_snapshots is missing';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'private.routing_snapshots', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'private.routing_snapshots', 'insert')
     or pg_catalog.has_table_privilege('anon', 'private.routing_snapshots', 'select') then
    raise exception 'routing_snapshots must have no client table privileges';
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.publish_routing_snapshot_v1(text,jsonb)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.get_routing_snapshots_v1()', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.clear_routing_snapshot_v1(text)', 'execute') then
    raise exception 'authenticated cannot execute the routing snapshot RPCs';
  end if;
  if pg_catalog.has_function_privilege('anon', 'public.publish_routing_snapshot_v1(text,jsonb)', 'execute')
     or pg_catalog.has_function_privilege('anon', 'public.get_routing_snapshots_v1()', 'execute')
     or pg_catalog.has_function_privilege('anon', 'public.clear_routing_snapshot_v1(text)', 'execute')
     or pg_catalog.has_function_privilege('authenticated', 'private.validate_routing_snapshot_v1(jsonb,timestamptz)', 'execute') then
    raise exception 'routing snapshot functions are executable beyond authenticated public RPCs';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname like '%routing_snapshot%'
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'a routing snapshot function lacks an empty fixed search_path';
  end if;
end;
$schema$;

create temporary table routing_fixture (name text primary key, body jsonb not null);
grant select on routing_fixture to authenticated;
insert into routing_fixture values (
  'ok',
  pg_catalog.jsonb_build_object(
    'v', 1,
    'generatedAt', pg_catalog.to_char(pg_catalog.now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sources', '[{"id":"tokenledger","reachable":true},{"id":"external","reachable":false,"note":"外部网关未运行"}]'::jsonb,
    'flows', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', '9f2c4e1a7b3d5f60', 'source', 'tokenledger', 'agent', 'codex', 'via', 'group/coding',
        'phase', 'routed', 'at', pg_catalog.to_char(pg_catalog.now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'hops', '[{"target":"openai/gpt-5","outcome":"failed","status":429},{"target":"deepseek/deepseek-chat","outcome":"ok"}]'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'id', '0123456789abcdef', 'source', 'external', 'agent', 'Agent', 'via', 'gpt-5',
        'phase', 'inflight', 'at', pg_catalog.to_char(pg_catalog.now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'waitingOn', 'rpm', 'hops', '[{"target":"openai/gpt-5","outcome":"pending"}]'::jsonb
      )
    )
  )
);

-- Anonymous callers are refused.
do $anon$
begin
  begin
    perform public.get_routing_snapshots_v1();
    raise exception 'anonymous read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$anon$;

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '7a5e0000-0000-4000-8000-000000000001', true);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $owner$
declare
  v_ok jsonb := (select body from routing_fixture where name = 'ok');
  v_result jsonb;
  v_read jsonb;
  v_bad jsonb;
  v_case text;
  v_reason text;
begin
  -- Direct table access is closed.
  begin
    perform 1 from private.routing_snapshots;
    raise exception 'direct table read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  v_result := public.publish_routing_snapshot_v1('aaaaaaaaaaaaaaaa', v_ok);
  if v_result ->> 'stored' <> 'true' or v_result -> 'receivedAt' is null then
    raise exception 'publish did not store: %', v_result;
  end if;

  v_read := public.get_routing_snapshots_v1();
  if pg_catalog.jsonb_array_length(v_read -> 'snapshots') <> 1
     or v_read #>> '{snapshots,0,device}' <> 'aaaaaaaaaaaaaaaa'
     or v_read #> '{snapshots,0,snapshot}' <> v_ok
     or v_read -> 'serverTime' is null then
    raise exception 'read did not return the stored snapshot: %', v_read;
  end if;

  -- An older snapshot never replaces a newer one.
  v_result := public.publish_routing_snapshot_v1(
    'aaaaaaaaaaaaaaaa',
    pg_catalog.jsonb_set(v_ok, '{generatedAt}', '"2020-01-01T00:00:00Z"'::jsonb)
  );
  if v_result ->> 'stored' <> 'false' then
    raise exception 'older snapshot replaced a newer one: %', v_result;
  end if;

  -- Rejections: one per contract rule.
  foreach v_case in array array[
    'device', 'version', 'unknown_key', 'future', 'source_dup', 'source_id', 'flow_id',
    'flow_dup', 'phase', 'waiting_done', 'hop_outcome', 'hop_status', 'hop_key', 'agent_long',
    'too_many_flows', 'too_large'
  ]
  loop
    v_bad := case v_case
      when 'version' then pg_catalog.jsonb_set(v_ok, '{v}', '2'::jsonb)
      when 'unknown_key' then v_ok || '{"session":"x"}'::jsonb
      when 'future' then pg_catalog.jsonb_set(v_ok, '{generatedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.now() + interval '1 hour') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
      when 'source_dup' then pg_catalog.jsonb_set(v_ok, '{sources}', '[{"id":"external","reachable":true},{"id":"external","reachable":false}]'::jsonb)
      when 'source_id' then pg_catalog.jsonb_set(v_ok, '{sources}', '[{"id":"cloud","reachable":true}]'::jsonb)
      when 'flow_id' then pg_catalog.jsonb_set(v_ok, '{flows,0,id}', '"req-123"'::jsonb)
      when 'flow_dup' then pg_catalog.jsonb_set(v_ok, '{flows,1,id}', '"9f2c4e1a7b3d5f60"'::jsonb)
      when 'phase' then pg_catalog.jsonb_set(v_ok, '{flows,0,phase}', '"streaming"'::jsonb)
      when 'waiting_done' then pg_catalog.jsonb_set(v_ok, '{flows,0,waitingOn}', '"rpm"'::jsonb)
      when 'hop_outcome' then pg_catalog.jsonb_set(v_ok, '{flows,0,hops,0,outcome}', '"maybe"'::jsonb)
      when 'hop_status' then pg_catalog.jsonb_set(v_ok, '{flows,0,hops,0,status}', '"429"'::jsonb)
      when 'hop_key' then pg_catalog.jsonb_set(v_ok, '{flows,0,hops,0,error}', '"quota exceeded for key sk-..."'::jsonb)
      when 'agent_long' then pg_catalog.jsonb_set(v_ok, '{flows,0,agent}', pg_catalog.to_jsonb(pg_catalog.repeat('a', 65)))
      when 'too_many_flows' then pg_catalog.jsonb_set(v_ok, '{flows}', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_set(v_ok #> '{flows,0}', '{id}', pg_catalog.to_jsonb(pg_catalog.lpad(pg_catalog.to_hex(i), 16, '0'))))
        from pg_catalog.generate_series(1, 25) as g(i)
      ))
      when 'too_large' then pg_catalog.jsonb_set(v_ok, '{sources,1,note}', pg_catalog.to_jsonb(pg_catalog.repeat('长', 6000)))
      else v_ok
    end;
    begin
      perform public.publish_routing_snapshot_v1(
        case when v_case = 'device' then 'MY-LAPTOP' else 'bbbbbbbbbbbbbbbb' end,
        v_bad
      );
      raise exception 'case % was accepted', v_case;
    exception when invalid_parameter_value then
      get stacked diagnostics v_reason = message_text;
      if v_case = 'too_large' and v_reason <> 'routing_snapshot_payload_too_large' then
        raise exception 'case too_large reported %', v_reason;
      elsif v_case <> 'too_large' and v_reason <> 'routing_snapshot_invalid_payload' then
        raise exception 'case % reported %', v_case, v_reason;
      end if;
    end;
  end loop;

  -- Eight devices per owner; a ninth new device is refused, the existing ones still update.
  for i in 2..8 loop
    perform public.publish_routing_snapshot_v1(pg_catalog.repeat(pg_catalog.to_hex(i + 1), 16), v_ok);
  end loop;
  begin
    perform public.publish_routing_snapshot_v1('ffffffffffffffff', v_ok);
    raise exception 'ninth device was accepted';
  exception when invalid_parameter_value then
    get stacked diagnostics v_reason = message_text;
    if v_reason <> 'routing_snapshot_capacity_exceeded' then
      raise exception 'ninth device reported %', v_reason;
    end if;
  end;
  if public.publish_routing_snapshot_v1('aaaaaaaaaaaaaaaa', v_ok) ->> 'stored' <> 'true' then
    raise exception 'an existing device could not update at capacity';
  end if;
  if pg_catalog.jsonb_array_length(public.get_routing_snapshots_v1() -> 'snapshots') <> 8 then
    raise exception 'read did not return all eight devices';
  end if;

  if public.clear_routing_snapshot_v1('aaaaaaaaaaaaaaaa') ->> 'deleted' <> 'true'
     or public.clear_routing_snapshot_v1('aaaaaaaaaaaaaaaa') ->> 'deleted' <> 'false' then
    raise exception 'clear did not delete exactly once';
  end if;
end;
$owner$;

-- Another owner sees nothing and cannot clear the first owner's rows.
select pg_catalog.set_config('request.jwt.claim.sub', '7a5e0000-0000-4000-8000-000000000002', true);
do $other$
begin
  if pg_catalog.jsonb_array_length(public.get_routing_snapshots_v1() -> 'snapshots') <> 0 then
    raise exception 'another owner can read routing snapshots';
  end if;
  if public.clear_routing_snapshot_v1('3333333333333333') ->> 'deleted' <> 'false' then
    raise exception 'another owner deleted a routing snapshot';
  end if;
end;
$other$;

reset role;

-- Stale rows: hidden from reads after 15 minutes, purged after one day on the next publish.
update private.routing_snapshots
set received_at = pg_catalog.clock_timestamp() - interval '2 days'
where user_id = '7a5e0000-0000-4000-8000-000000000001' and device = '3333333333333333';
update private.routing_snapshots
set received_at = pg_catalog.clock_timestamp() - interval '20 minutes'
where user_id = '7a5e0000-0000-4000-8000-000000000001' and device = '4444444444444444';

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '7a5e0000-0000-4000-8000-000000000001', true);
do $stale$
declare
  v_read jsonb := public.get_routing_snapshots_v1();
begin
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_read -> 'snapshots') as s(value)
    where s.value ->> 'device' in ('3333333333333333', '4444444444444444')
  ) then
    raise exception 'stale snapshots were returned: %', v_read;
  end if;
  perform public.publish_routing_snapshot_v1('5555555555555555', (select body from routing_fixture where name = 'ok'));
end;
$stale$;
reset role;

do $purge$
begin
  if exists (
    select 1 from private.routing_snapshots
    where user_id = '7a5e0000-0000-4000-8000-000000000001' and device = '3333333333333333'
  ) then
    raise exception 'a day-old snapshot survived a publish';
  end if;
  if not exists (
    select 1 from private.routing_snapshots
    where user_id = '7a5e0000-0000-4000-8000-000000000001' and device = '4444444444444444'
  ) then
    raise exception 'a recent but hidden snapshot was purged too early';
  end if;
end;
$purge$;

rollback;
