-- TokenLedger budget status relay (budget-snapshot-v1).
-- The desktop publishes one small, redacted budget status snapshot per device;
-- the Android app reads the recent ones and raises local notifications. Only
-- the latest snapshot per device is kept, and rows older than three days are
-- purged on publish and by an hourly job.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table private.budget_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  device text not null,
  snapshot jsonb not null,
  generated_at timestamptz not null,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, device),
  constraint budget_snapshots_device_check
    check (device ~ '^[0-9a-f]{16,64}$'),
  constraint budget_snapshots_object_check
    check (pg_catalog.jsonb_typeof(snapshot) = 'object')
);

create index budget_snapshots_received_at_idx
  on private.budget_snapshots (received_at);

alter table private.budget_snapshots enable row level security;
alter table private.budget_snapshots force row level security;

drop policy if exists budget_snapshots_select_own on private.budget_snapshots;
create policy budget_snapshots_select_own
  on private.budget_snapshots
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No client grants; the SELECT policy is defense in depth only.
revoke all on table private.budget_snapshots
  from public, anon, authenticated, service_role;

create or replace function private.budget_snapshot_fail_v1(p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_reason not in ('invalid_payload', 'payload_too_large', 'capacity_exceeded') then
    p_reason := 'invalid_payload';
  end if;
  raise exception using
    errcode = '22023',
    message = 'budget_snapshot_' || p_reason;
end;
$$;

create or replace function private.budget_snapshot_time_v1(p_value jsonb)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string'
     or pg_catalog.char_length(p_value #>> '{}') > 40
     or (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}' then
    return null;
  end if;
  return (p_value #>> '{}')::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function private.budget_snapshot_date_ok_v1(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string'
     or (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  return pg_catalog.to_char((p_value #>> '{}')::date, 'YYYY-MM-DD') = (p_value #>> '{}');
exception when others then
  return false;
end;
$$;

-- Structure, value sets and lengths only (contract §3). Unknown keys are rejected.
create or replace function private.validate_budget_snapshot_v1(p_snapshot jsonb, p_now timestamptz)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_generated timestamptz;
  v_budget jsonb;
  v_ids text[] := array[]::text[];
begin
  if p_snapshot is null or pg_catalog.jsonb_typeof(p_snapshot) <> 'object' then
    perform private.budget_snapshot_fail_v1('invalid_payload');
  end if;
  if pg_catalog.octet_length(p_snapshot::text) > 8192 then
    perform private.budget_snapshot_fail_v1('payload_too_large');
  end if;
  if not (p_snapshot ?& array['v', 'generatedAt', 'budgets']::text[])
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_snapshot) as k(key)
       where k.key not in ('v', 'generatedAt', 'budgets')
     )
     or p_snapshot -> 'v' <> '1'::jsonb
     or pg_catalog.jsonb_typeof(p_snapshot -> 'budgets') <> 'array'
     or pg_catalog.jsonb_array_length(p_snapshot -> 'budgets') > 32 then
    perform private.budget_snapshot_fail_v1('invalid_payload');
  end if;

  v_generated := private.budget_snapshot_time_v1(p_snapshot -> 'generatedAt');
  if v_generated is null or v_generated > p_now + interval '5 minutes' then
    perform private.budget_snapshot_fail_v1('invalid_payload');
  end if;

  for v_budget in
    select b.value from pg_catalog.jsonb_array_elements(p_snapshot -> 'budgets') as b(value)
  loop
    if pg_catalog.jsonb_typeof(v_budget) <> 'object'
       or not (v_budget ?& array['id', 'label', 'period', 'metric', 'periodStart', 'percent', 'level']::text[])
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(v_budget) as k(key)
         where k.key not in ('id', 'label', 'period', 'metric', 'periodStart', 'percent', 'level')
       )
       or pg_catalog.jsonb_typeof(v_budget -> 'id') <> 'string'
       or (v_budget ->> 'id') !~ '^[0-9a-f]{16}$'
       or (v_budget ->> 'id') = any(v_ids)
       or pg_catalog.jsonb_typeof(v_budget -> 'label') <> 'string'
       or pg_catalog.char_length(v_budget ->> 'label') not between 1 and 32
       or (v_budget ->> 'label') ~ '[[:cntrl:]/\\@:$¥€£~]'
       or pg_catalog.jsonb_typeof(v_budget -> 'period') <> 'string'
       or (v_budget ->> 'period') not in ('day', 'week', 'month')
       or pg_catalog.jsonb_typeof(v_budget -> 'metric') <> 'string'
       or (v_budget ->> 'metric') not in ('cost', 'tokens')
       or not private.budget_snapshot_date_ok_v1(v_budget -> 'periodStart')
       or pg_catalog.jsonb_typeof(v_budget -> 'percent') <> 'number'
       or (v_budget #>> '{percent}') !~ '^[0-9]{1,5}$'
       or pg_catalog.jsonb_typeof(v_budget -> 'level') <> 'string'
       or (v_budget ->> 'level') not in ('ok', 'warn', 'over') then
      perform private.budget_snapshot_fail_v1('invalid_payload');
    end if;
    v_ids := v_ids || (v_budget ->> 'id');
  end loop;

  return v_generated;
end;
$$;

create or replace function private.budget_snapshot_identity_v1()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null or not exists (select 1 from auth.users where id = v_user) then
    raise exception using errcode = '42501', message = 'budget_snapshot_identity_required';
  end if;
  return v_user;
end;
$$;

create or replace function public.publish_budget_snapshot_v1(p_device text, p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.budget_snapshot_identity_v1();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_generated timestamptz;
  v_existing timestamptz;
  v_devices integer;
begin
  if p_device is null or p_device !~ '^[0-9a-f]{16,64}$' then
    perform private.budget_snapshot_fail_v1('invalid_payload');
  end if;
  v_generated := private.validate_budget_snapshot_v1(p_snapshot, v_now);

  -- Serialize publishes per owner so the device cap holds under concurrency.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('budget_snapshot:' || v_user::text, 0)
  );

  delete from private.budget_snapshots
  where user_id = v_user and received_at < v_now - interval '3 days';

  select generated_at into v_existing
  from private.budget_snapshots
  where user_id = v_user and device = p_device
  for update;

  if v_existing is null then
    select pg_catalog.count(*)::integer into v_devices
    from private.budget_snapshots
    where user_id = v_user;
    if v_devices >= 8 then
      perform private.budget_snapshot_fail_v1('capacity_exceeded');
    end if;
  elsif v_existing > v_generated then
    return pg_catalog.jsonb_build_object('stored', false);
  end if;

  insert into private.budget_snapshots (user_id, device, snapshot, generated_at, received_at)
  values (v_user, p_device, p_snapshot, v_generated, v_now)
  on conflict (user_id, device) do update
  set snapshot = excluded.snapshot,
      generated_at = excluded.generated_at,
      received_at = excluded.received_at;

  return pg_catalog.jsonb_build_object('stored', true, 'receivedAt', v_now);
end;
$$;

create or replace function public.get_budget_snapshots_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.budget_snapshot_identity_v1();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_rows jsonb;
begin
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'device', r.device,
        'receivedAt', r.received_at,
        'snapshot', r.snapshot
      ) order by r.received_at desc, r.device
    ),
    '[]'::jsonb
  ) into v_rows
  from (
    select s.device, s.received_at, s.snapshot
    from private.budget_snapshots s
    where s.user_id = v_user and s.received_at >= v_now - interval '2 days'
    order by s.received_at desc, s.device
    limit 8
  ) r;
  return pg_catalog.jsonb_build_object('serverTime', v_now, 'snapshots', v_rows);
end;
$$;

create or replace function public.clear_budget_snapshot_v1(p_device text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.budget_snapshot_identity_v1();
  v_count integer;
begin
  if p_device is null or p_device !~ '^[0-9a-f]{16,64}$' then
    perform private.budget_snapshot_fail_v1('invalid_payload');
  end if;
  delete from private.budget_snapshots
  where user_id = v_user and device = p_device;
  get diagnostics v_count = row_count;
  return pg_catalog.jsonb_build_object('deleted', v_count > 0);
end;
$$;

-- Owner-independent expiry: a user who stops publishing (lost device, uninstall)
-- must not keep a snapshot forever just because nobody publishes for them.
create or replace function private.purge_expired_budget_snapshots_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.budget_snapshots
  where received_at < pg_catalog.clock_timestamp() - interval '3 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create extension if not exists pg_cron;

select cron.schedule(
  'tokenledger-budget-snapshot-hourly-purge',
  '23 * * * *',
  $cron$select private.purge_expired_budget_snapshots_v1();$cron$
);

revoke execute on function private.purge_expired_budget_snapshots_v1()
  from public, anon, authenticated, service_role;
revoke execute on function private.budget_snapshot_fail_v1(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.budget_snapshot_time_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.budget_snapshot_date_ok_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.validate_budget_snapshot_v1(jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function private.budget_snapshot_identity_v1()
  from public, anon, authenticated, service_role;

revoke execute on function public.publish_budget_snapshot_v1(text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_budget_snapshots_v1()
  from public, anon, authenticated, service_role;
revoke execute on function public.clear_budget_snapshot_v1(text)
  from public, anon, authenticated, service_role;

grant execute on function public.publish_budget_snapshot_v1(text, jsonb) to authenticated;
grant execute on function public.get_budget_snapshots_v1() to authenticated;
grant execute on function public.clear_budget_snapshot_v1(text) to authenticated;

comment on table private.budget_snapshots
  is 'Latest redacted budget status snapshot per owner device (budget-snapshot-v1); purged after three days.';
comment on function public.publish_budget_snapshot_v1(text, jsonb)
  is 'Replace this device''s budget status snapshot for the authenticated owner unless a newer one is stored.';
comment on function public.get_budget_snapshots_v1()
  is 'Read the authenticated owner''s budget status snapshots received in the last two days.';
comment on function public.clear_budget_snapshot_v1(text)
  is 'Delete this device''s budget status snapshot for the authenticated owner.';
