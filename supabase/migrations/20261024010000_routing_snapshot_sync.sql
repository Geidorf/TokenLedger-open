-- TokenLedger live routing snapshot relay (routing-snapshot-v1).
-- The desktop publishes one small, redacted snapshot per device; the Android
-- live wallpaper reads the recent ones. Only the latest snapshot per device is
-- kept, and rows older than one day are purged on publish.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table private.routing_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  device text not null,
  snapshot jsonb not null,
  generated_at timestamptz not null,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, device),
  constraint routing_snapshots_device_check
    check (device ~ '^[0-9a-f]{16,64}$'),
  constraint routing_snapshots_object_check
    check (pg_catalog.jsonb_typeof(snapshot) = 'object')
);

create index routing_snapshots_received_at_idx
  on private.routing_snapshots (received_at);

alter table private.routing_snapshots enable row level security;
alter table private.routing_snapshots force row level security;

drop policy if exists routing_snapshots_select_own on private.routing_snapshots;
create policy routing_snapshots_select_own
  on private.routing_snapshots
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No client grants; the SELECT policy is defense in depth only.
revoke all on table private.routing_snapshots
  from public, anon, authenticated, service_role;

create or replace function private.routing_snapshot_fail_v1(p_reason text)
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
    message = 'routing_snapshot_' || p_reason;
end;
$$;

create or replace function private.routing_snapshot_text_ok_v1(
  p_value jsonb,
  p_max integer,
  p_optional boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then p_optional
    when pg_catalog.jsonb_typeof(p_value) <> 'string' then false
    else pg_catalog.char_length(p_value #>> '{}') between 1 and p_max
  end;
$$;

create or replace function private.routing_snapshot_time_v1(p_value jsonb)
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

-- Structure, value sets and lengths only (contract §3). Unknown keys are rejected.
create or replace function private.validate_routing_snapshot_v1(p_snapshot jsonb, p_now timestamptz)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_generated timestamptz;
  v_source jsonb;
  v_flow jsonb;
  v_hop jsonb;
  v_status jsonb;
  v_ids text[] := array[]::text[];
begin
  if p_snapshot is null or pg_catalog.jsonb_typeof(p_snapshot) <> 'object' then
    perform private.routing_snapshot_fail_v1('invalid_payload');
  end if;
  if pg_catalog.octet_length(p_snapshot::text) > 16384 then
    perform private.routing_snapshot_fail_v1('payload_too_large');
  end if;
  if not (p_snapshot ?& array['v', 'generatedAt', 'sources', 'flows']::text[])
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_snapshot) as k(key)
       where k.key not in ('v', 'generatedAt', 'sources', 'flows')
     )
     or p_snapshot -> 'v' <> '1'::jsonb
     or pg_catalog.jsonb_typeof(p_snapshot -> 'sources') <> 'array'
     or pg_catalog.jsonb_array_length(p_snapshot -> 'sources') > 2
     or pg_catalog.jsonb_typeof(p_snapshot -> 'flows') <> 'array'
     or pg_catalog.jsonb_array_length(p_snapshot -> 'flows') > 24 then
    perform private.routing_snapshot_fail_v1('invalid_payload');
  end if;

  v_generated := private.routing_snapshot_time_v1(p_snapshot -> 'generatedAt');
  if v_generated is null or v_generated > p_now + interval '5 minutes' then
    perform private.routing_snapshot_fail_v1('invalid_payload');
  end if;

  for v_source in
    select s.value from pg_catalog.jsonb_array_elements(p_snapshot -> 'sources') as s(value)
  loop
    if pg_catalog.jsonb_typeof(v_source) <> 'object'
       or not (v_source ?& array['id', 'reachable']::text[])
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(v_source) as k(key)
         where k.key not in ('id', 'reachable', 'note')
       )
       or (v_source ->> 'id') is null
       or (v_source ->> 'id') not in ('tokenledger', 'external')
       or pg_catalog.jsonb_typeof(v_source -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_source -> 'reachable') <> 'boolean'
       or not private.routing_snapshot_text_ok_v1(v_source -> 'note', 64, true)
       or ('source:' || (v_source ->> 'id')) = any(v_ids) then
      perform private.routing_snapshot_fail_v1('invalid_payload');
    end if;
    v_ids := v_ids || ('source:' || (v_source ->> 'id'));
  end loop;

  for v_flow in
    select f.value from pg_catalog.jsonb_array_elements(p_snapshot -> 'flows') as f(value)
  loop
    if pg_catalog.jsonb_typeof(v_flow) <> 'object'
       or not (v_flow ?& array['id', 'source', 'agent', 'via', 'phase', 'at', 'hops']::text[])
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(v_flow) as k(key)
         where k.key not in ('id', 'source', 'agent', 'via', 'phase', 'at', 'waitingOn', 'hops')
       )
       or pg_catalog.jsonb_typeof(v_flow -> 'id') <> 'string'
       or (v_flow ->> 'id') !~ '^[0-9a-f]{16}$'
       or ('flow:' || (v_flow ->> 'id')) = any(v_ids)
       or pg_catalog.jsonb_typeof(v_flow -> 'source') <> 'string'
       or (v_flow ->> 'source') not in ('tokenledger', 'external')
       or not private.routing_snapshot_text_ok_v1(v_flow -> 'agent', 64, false)
       or not private.routing_snapshot_text_ok_v1(v_flow -> 'via', 128, false)
       or pg_catalog.jsonb_typeof(v_flow -> 'phase') <> 'string'
       or (v_flow ->> 'phase') not in ('inflight', 'routed', 'done', 'failed')
       or private.routing_snapshot_time_v1(v_flow -> 'at') is null
       or (
         v_flow ? 'waitingOn'
         and (
           v_flow ->> 'phase' <> 'inflight'
           or pg_catalog.jsonb_typeof(v_flow -> 'waitingOn') <> 'string'
           or (v_flow ->> 'waitingOn') not in ('slot', 'rpm', 'upstream')
         )
       )
       or pg_catalog.jsonb_typeof(v_flow -> 'hops') <> 'array'
       or pg_catalog.jsonb_array_length(v_flow -> 'hops') > 8 then
      perform private.routing_snapshot_fail_v1('invalid_payload');
    end if;
    v_ids := v_ids || ('flow:' || (v_flow ->> 'id'));

    for v_hop in
      select h.value from pg_catalog.jsonb_array_elements(v_flow -> 'hops') as h(value)
    loop
      v_status := v_hop -> 'status';
      if pg_catalog.jsonb_typeof(v_hop) <> 'object'
         or not (v_hop ?& array['target', 'outcome']::text[])
         or exists (
           select 1 from pg_catalog.jsonb_object_keys(v_hop) as k(key)
           where k.key not in ('target', 'outcome', 'status')
         )
         or not private.routing_snapshot_text_ok_v1(v_hop -> 'target', 128, false)
         or pg_catalog.jsonb_typeof(v_hop -> 'outcome') <> 'string'
         or (v_hop ->> 'outcome') not in ('ok', 'failed', 'rejected', 'skipped', 'pending')
         or (
           v_status is not null
           and (
             pg_catalog.jsonb_typeof(v_status) <> 'number'
             or (v_status #>> '{}') !~ '^[1-5][0-9]{2}$'
           )
         ) then
        perform private.routing_snapshot_fail_v1('invalid_payload');
      end if;
    end loop;
  end loop;

  return v_generated;
end;
$$;

create or replace function private.routing_snapshot_identity_v1()
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
    raise exception using errcode = '42501', message = 'routing_snapshot_identity_required';
  end if;
  return v_user;
end;
$$;

create or replace function public.publish_routing_snapshot_v1(p_device text, p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.routing_snapshot_identity_v1();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_generated timestamptz;
  v_existing timestamptz;
  v_devices integer;
begin
  if p_device is null or p_device !~ '^[0-9a-f]{16,64}$' then
    perform private.routing_snapshot_fail_v1('invalid_payload');
  end if;
  v_generated := private.validate_routing_snapshot_v1(p_snapshot, v_now);

  -- Serialize publishes per owner so the device cap holds under concurrency.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('routing_snapshot:' || v_user::text, 0)
  );

  delete from private.routing_snapshots
  where user_id = v_user and received_at < v_now - interval '1 day';

  select generated_at into v_existing
  from private.routing_snapshots
  where user_id = v_user and device = p_device
  for update;

  if v_existing is null then
    select pg_catalog.count(*)::integer into v_devices
    from private.routing_snapshots
    where user_id = v_user;
    if v_devices >= 8 then
      perform private.routing_snapshot_fail_v1('capacity_exceeded');
    end if;
  elsif v_existing > v_generated then
    return pg_catalog.jsonb_build_object('stored', false);
  end if;

  insert into private.routing_snapshots (user_id, device, snapshot, generated_at, received_at)
  values (v_user, p_device, p_snapshot, v_generated, v_now)
  on conflict (user_id, device) do update
  set snapshot = excluded.snapshot,
      generated_at = excluded.generated_at,
      received_at = excluded.received_at;

  return pg_catalog.jsonb_build_object('stored', true, 'receivedAt', v_now);
end;
$$;

create or replace function public.get_routing_snapshots_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.routing_snapshot_identity_v1();
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
    from private.routing_snapshots s
    where s.user_id = v_user and s.received_at >= v_now - interval '15 minutes'
    order by s.received_at desc, s.device
    limit 8
  ) r;
  return pg_catalog.jsonb_build_object('serverTime', v_now, 'snapshots', v_rows);
end;
$$;

create or replace function public.clear_routing_snapshot_v1(p_device text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.routing_snapshot_identity_v1();
  v_count integer;
begin
  if p_device is null or p_device !~ '^[0-9a-f]{16,64}$' then
    perform private.routing_snapshot_fail_v1('invalid_payload');
  end if;
  delete from private.routing_snapshots
  where user_id = v_user and device = p_device;
  get diagnostics v_count = row_count;
  return pg_catalog.jsonb_build_object('deleted', v_count > 0);
end;
$$;

-- Owner-independent expiry: a user who stops publishing (lost device, uninstall)
-- must not keep a snapshot forever just because nobody publishes for them.
create or replace function private.purge_expired_routing_snapshots_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.routing_snapshots
  where received_at < pg_catalog.clock_timestamp() - interval '1 day';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create extension if not exists pg_cron;

select cron.schedule(
  'tokenledger-routing-snapshot-hourly-purge',
  '17 * * * *',
  $cron$select private.purge_expired_routing_snapshots_v1();$cron$
);

revoke execute on function private.purge_expired_routing_snapshots_v1()
  from public, anon, authenticated, service_role;
revoke execute on function private.routing_snapshot_fail_v1(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.routing_snapshot_text_ok_v1(jsonb, integer, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function private.routing_snapshot_time_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.validate_routing_snapshot_v1(jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function private.routing_snapshot_identity_v1()
  from public, anon, authenticated, service_role;

revoke execute on function public.publish_routing_snapshot_v1(text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_routing_snapshots_v1()
  from public, anon, authenticated, service_role;
revoke execute on function public.clear_routing_snapshot_v1(text)
  from public, anon, authenticated, service_role;

grant execute on function public.publish_routing_snapshot_v1(text, jsonb) to authenticated;
grant execute on function public.get_routing_snapshots_v1() to authenticated;
grant execute on function public.clear_routing_snapshot_v1(text) to authenticated;

comment on table private.routing_snapshots
  is 'Latest redacted live routing snapshot per owner device (routing-snapshot-v1); purged after one day.';
comment on function public.publish_routing_snapshot_v1(text, jsonb)
  is 'Replace this device''s live routing snapshot for the authenticated owner unless a newer one is stored.';
comment on function public.get_routing_snapshots_v1()
  is 'Read the authenticated owner''s live routing snapshots received in the last 15 minutes.';
comment on function public.clear_routing_snapshot_v1(text)
  is 'Delete this device''s live routing snapshot for the authenticated owner.';
