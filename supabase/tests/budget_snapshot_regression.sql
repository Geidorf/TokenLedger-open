\set ON_ERROR_STOP on

-- budget-snapshot-v1: owner-scoped budget status relay.
begin;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    'b0d6e000-0000-4000-8000-000000000001',
    'budget-snapshot@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  ),
  (
    'b0d6e000-0000-4000-8000-000000000002',
    'budget-snapshot-other@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  );

do $schema$
begin
  if pg_catalog.to_regclass('private.budget_snapshots') is null then
    raise exception 'private.budget_snapshots is missing';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'private.budget_snapshots', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'private.budget_snapshots', 'insert')
     or pg_catalog.has_table_privilege('anon', 'private.budget_snapshots', 'select') then
    raise exception 'budget_snapshots must have no client table privileges';
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.publish_budget_snapshot_v1(text,jsonb)', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.get_budget_snapshots_v1()', 'execute')
     or not pg_catalog.has_function_privilege('authenticated', 'public.clear_budget_snapshot_v1(text)', 'execute') then
    raise exception 'authenticated cannot execute the budget snapshot RPCs';
  end if;
  if pg_catalog.has_function_privilege('anon', 'public.publish_budget_snapshot_v1(text,jsonb)', 'execute')
     or pg_catalog.has_function_privilege('anon', 'public.get_budget_snapshots_v1()', 'execute')
     or pg_catalog.has_function_privilege('anon', 'public.clear_budget_snapshot_v1(text)', 'execute')
     or pg_catalog.has_function_privilege('authenticated', 'private.validate_budget_snapshot_v1(jsonb,timestamptz)', 'execute') then
    raise exception 'budget snapshot functions are executable beyond authenticated public RPCs';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname like '%budget_snapshot%'
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'a budget snapshot function lacks an empty fixed search_path';
  end if;
end;
$schema$;

create temporary table budget_fixture (name text primary key, body jsonb not null);
grant select on budget_fixture to authenticated;
insert into budget_fixture values (
  'ok',
  pg_catalog.jsonb_build_object(
    'v', 1,
    'generatedAt', pg_catalog.to_char(pg_catalog.now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'budgets', '[
      {"id":"9f2c4e1a7b3d5f60","label":"Codex","period":"month","metric":"cost","periodStart":"2026-10-01","percent":85,"level":"warn"},
      {"id":"0123456789abcdef","label":"全部用量","period":"day","metric":"tokens","periodStart":"2026-10-24","percent":112,"level":"over"},
      {"id":"fedcba9876543210","label":"gpt-5","period":"week","metric":"cost","periodStart":"2026-10-20","percent":0,"level":"ok"}
    ]'::jsonb
  )
);

-- Anonymous callers are refused.
do $anon$
begin
  begin
    perform public.get_budget_snapshots_v1();
    raise exception 'anonymous read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$anon$;

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', 'b0d6e000-0000-4000-8000-000000000001', true);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $owner$
declare
  v_ok jsonb := (select body from budget_fixture where name = 'ok');
  v_result jsonb;
  v_read jsonb;
  v_bad jsonb;
  v_case text;
  v_reason text;
begin
  begin
    perform 1 from private.budget_snapshots;
    raise exception 'direct table read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  v_result := public.publish_budget_snapshot_v1('aaaaaaaaaaaaaaaa', v_ok);
  if v_result ->> 'stored' <> 'true' or v_result -> 'receivedAt' is null then
    raise exception 'publish did not store: %', v_result;
  end if;

  v_read := public.get_budget_snapshots_v1();
  if pg_catalog.jsonb_array_length(v_read -> 'snapshots') <> 1
     or v_read #>> '{snapshots,0,device}' <> 'aaaaaaaaaaaaaaaa'
     or v_read #> '{snapshots,0,snapshot}' <> v_ok
     or v_read -> 'serverTime' is null then
    raise exception 'read did not return the stored snapshot: %', v_read;
  end if;

  -- An empty budget list is a valid snapshot (no budget near or over yet).
  if public.publish_budget_snapshot_v1('aaaaaaaaaaaaaaaa', pg_catalog.jsonb_set(v_ok, '{budgets}', '[]'::jsonb)) ->> 'stored' <> 'true' then
    raise exception 'an empty budget list was refused';
  end if;

  -- The largest snapshot the contract allows (32 budgets, 32-character CJK labels,
  -- five-digit percents) fits under the byte cap.
  if public.publish_budget_snapshot_v1('aaaaaaaaaaaaaaaa', pg_catalog.jsonb_set(v_ok, '{budgets}', (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', pg_catalog.lpad(pg_catalog.to_hex(i), 16, '0'), 'label', pg_catalog.repeat('长', 32),
      'period', 'month', 'metric', 'tokens', 'periodStart', '2026-10-01', 'percent', 99999, 'level', 'over'))
    from pg_catalog.generate_series(1, 32) as g(i)
  ))) ->> 'stored' <> 'true' then
    raise exception 'the largest valid snapshot was refused';
  end if;

  v_result := public.publish_budget_snapshot_v1(
    'aaaaaaaaaaaaaaaa',
    pg_catalog.jsonb_set(v_ok, '{generatedAt}', '"2020-01-01T00:00:00Z"'::jsonb)
  );
  if v_result ->> 'stored' <> 'false' then
    raise exception 'older snapshot replaced a newer one: %', v_result;
  end if;

  foreach v_case in array array[
    'device', 'version', 'unknown_key', 'future', 'budget_id', 'budget_dup', 'budget_key',
    'label_empty', 'label_long', 'label_path', 'label_amount', 'period', 'metric',
    'period_start', 'period_start_invalid', 'percent_fraction', 'percent_negative',
    'percent_text', 'percent_huge', 'level', 'level_unavailable', 'too_many', 'too_large'
  ]
  loop
    v_bad := case v_case
      when 'version' then pg_catalog.jsonb_set(v_ok, '{v}', '2'::jsonb)
      when 'unknown_key' then v_ok || '{"rules":[]}'::jsonb
      when 'future' then pg_catalog.jsonb_set(v_ok, '{generatedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.now() + interval '1 hour') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
      when 'budget_id' then pg_catalog.jsonb_set(v_ok, '{budgets,0,id}', '"rule-1"'::jsonb)
      when 'budget_dup' then pg_catalog.jsonb_set(v_ok, '{budgets,1,id}', '"9f2c4e1a7b3d5f60"'::jsonb)
      when 'budget_key' then pg_catalog.jsonb_set(v_ok, '{budgets,0,used}', '42.5'::jsonb)
      when 'label_empty' then pg_catalog.jsonb_set(v_ok, '{budgets,0,label}', '""'::jsonb)
      when 'label_long' then pg_catalog.jsonb_set(v_ok, '{budgets,0,label}', pg_catalog.to_jsonb(pg_catalog.repeat('a', 33)))
      when 'label_path' then pg_catalog.jsonb_set(v_ok, '{budgets,0,label}', '"relay/acct"'::jsonb)
      when 'label_amount' then pg_catalog.jsonb_set(v_ok, '{budgets,0,label}', '"$50"'::jsonb)
      when 'period' then pg_catalog.jsonb_set(v_ok, '{budgets,0,period}', '"year"'::jsonb)
      when 'metric' then pg_catalog.jsonb_set(v_ok, '{budgets,0,metric}', '"requests"'::jsonb)
      when 'period_start' then pg_catalog.jsonb_set(v_ok, '{budgets,0,periodStart}', '"2026-10-01T00:00:00Z"'::jsonb)
      when 'period_start_invalid' then pg_catalog.jsonb_set(v_ok, '{budgets,0,periodStart}', '"2026-02-30"'::jsonb)
      when 'percent_fraction' then pg_catalog.jsonb_set(v_ok, '{budgets,0,percent}', '85.5'::jsonb)
      when 'percent_negative' then pg_catalog.jsonb_set(v_ok, '{budgets,0,percent}', '-1'::jsonb)
      when 'percent_text' then pg_catalog.jsonb_set(v_ok, '{budgets,0,percent}', '"85"'::jsonb)
      when 'percent_huge' then pg_catalog.jsonb_set(v_ok, '{budgets,0,percent}', '100000'::jsonb)
      when 'level' then pg_catalog.jsonb_set(v_ok, '{budgets,0,level}', '"critical"'::jsonb)
      when 'level_unavailable' then pg_catalog.jsonb_set(v_ok, '{budgets,0,level}', '"unavailable"'::jsonb)
      when 'too_many' then pg_catalog.jsonb_set(v_ok, '{budgets}', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_set(v_ok #> '{budgets,0}', '{id}', pg_catalog.to_jsonb(pg_catalog.lpad(pg_catalog.to_hex(i), 16, '0'))))
        from pg_catalog.generate_series(1, 33) as g(i)
      ))
      when 'too_large' then pg_catalog.jsonb_set(v_ok, '{budgets,0,label}', pg_catalog.to_jsonb(pg_catalog.repeat('长', 3000)))
      else v_ok
    end;
    begin
      perform public.publish_budget_snapshot_v1(
        case when v_case = 'device' then 'MY-LAPTOP' else 'bbbbbbbbbbbbbbbb' end,
        v_bad
      );
      raise exception 'case % was accepted', v_case;
    exception when invalid_parameter_value then
      get stacked diagnostics v_reason = message_text;
      if v_case = 'too_large' and v_reason <> 'budget_snapshot_payload_too_large' then
        raise exception 'case too_large reported %', v_reason;
      elsif v_case <> 'too_large' and v_reason <> 'budget_snapshot_invalid_payload' then
        raise exception 'case % reported %', v_case, v_reason;
      end if;
    end;
  end loop;

  for i in 2..8 loop
    perform public.publish_budget_snapshot_v1(pg_catalog.repeat(pg_catalog.to_hex(i + 1), 16), v_ok);
  end loop;
  begin
    perform public.publish_budget_snapshot_v1('ffffffffffffffff', v_ok);
    raise exception 'ninth device was accepted';
  exception when invalid_parameter_value then
    get stacked diagnostics v_reason = message_text;
    if v_reason <> 'budget_snapshot_capacity_exceeded' then
      raise exception 'ninth device reported %', v_reason;
    end if;
  end;
  if public.publish_budget_snapshot_v1('aaaaaaaaaaaaaaaa', v_ok) ->> 'stored' <> 'true' then
    raise exception 'an existing device could not update at capacity';
  end if;
  if pg_catalog.jsonb_array_length(public.get_budget_snapshots_v1() -> 'snapshots') <> 8 then
    raise exception 'read did not return all eight devices';
  end if;

  if public.clear_budget_snapshot_v1('aaaaaaaaaaaaaaaa') ->> 'deleted' <> 'true'
     or public.clear_budget_snapshot_v1('aaaaaaaaaaaaaaaa') ->> 'deleted' <> 'false' then
    raise exception 'clear did not delete exactly once';
  end if;
end;
$owner$;

select pg_catalog.set_config('request.jwt.claim.sub', 'b0d6e000-0000-4000-8000-000000000002', true);
do $other$
begin
  if pg_catalog.jsonb_array_length(public.get_budget_snapshots_v1() -> 'snapshots') <> 0 then
    raise exception 'another owner can read budget snapshots';
  end if;
  if public.clear_budget_snapshot_v1('3333333333333333') ->> 'deleted' <> 'false' then
    raise exception 'another owner deleted a budget snapshot';
  end if;
end;
$other$;

reset role;

-- Stale rows: hidden from reads after two days, purged after three days on the next publish.
update private.budget_snapshots
set received_at = pg_catalog.clock_timestamp() - interval '4 days'
where user_id = 'b0d6e000-0000-4000-8000-000000000001' and device = '3333333333333333';
update private.budget_snapshots
set received_at = pg_catalog.clock_timestamp() - interval '50 hours'
where user_id = 'b0d6e000-0000-4000-8000-000000000001' and device = '4444444444444444';

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', 'b0d6e000-0000-4000-8000-000000000001', true);
do $stale$
declare
  v_read jsonb := public.get_budget_snapshots_v1();
begin
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(v_read -> 'snapshots') as s(value)
    where s.value ->> 'device' in ('3333333333333333', '4444444444444444')
  ) then
    raise exception 'stale snapshots were returned: %', v_read;
  end if;
  perform public.publish_budget_snapshot_v1('5555555555555555', (select body from budget_fixture where name = 'ok'));
end;
$stale$;
reset role;

do $purge$
begin
  if exists (
    select 1 from private.budget_snapshots
    where user_id = 'b0d6e000-0000-4000-8000-000000000001' and device = '3333333333333333'
  ) then
    raise exception 'a four-day-old snapshot survived a publish';
  end if;
  if not exists (
    select 1 from private.budget_snapshots
    where user_id = 'b0d6e000-0000-4000-8000-000000000001' and device = '4444444444444444'
  ) then
    raise exception 'a hidden but unexpired snapshot was purged too early';
  end if;
end;
$purge$;

do $abandoned$
begin
  if not exists (
    select 1 from cron.job
    where jobname = 'tokenledger-budget-snapshot-hourly-purge'
      and command like '%purge_expired_budget_snapshots_v1%'
  ) then
    raise exception 'budget snapshot purge job is not scheduled';
  end if;
  update private.budget_snapshots
  set received_at = pg_catalog.clock_timestamp() - interval '73 hours'
  where user_id = 'b0d6e000-0000-4000-8000-000000000001' and device = '4444444444444444';
  if private.purge_expired_budget_snapshots_v1() <> 1 then
    raise exception 'purge did not remove exactly the abandoned row';
  end if;
  if pg_catalog.has_function_privilege('authenticated', 'private.purge_expired_budget_snapshots_v1()', 'execute') then
    raise exception 'clients can run the budget snapshot purge';
  end if;
end;
$abandoned$;

rollback;
