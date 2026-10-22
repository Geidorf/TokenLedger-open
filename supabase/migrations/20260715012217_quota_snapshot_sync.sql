-- TokenLedger owner-scoped quota snapshot sync (quota-provider-v1).
-- Raw provider credentials and local-only fields never enter these tables.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create extension if not exists pg_cron;

create table private.quota_snapshot_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  epoch bigint not null default 1,
  revision bigint not null default 0,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint quota_snapshot_state_epoch_range
    check (epoch between 0 and 9007199254740991),
  constraint quota_snapshot_state_revision_range
    check (revision between 0 and 9007199254740991)
);

create table private.quota_snapshots (
  user_id uuid not null references private.quota_snapshot_state(user_id) on delete cascade,
  provider_id text not null,
  scope text not null,
  sort_order smallint not null,
  envelope jsonb not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (user_id, provider_id, scope),
  constraint quota_snapshots_scope_check
    check (scope in ('consumer-subscription', 'api-organization', 'manual-budget')),
  constraint quota_snapshots_sort_order_check check (sort_order between 1 and 8),
  constraint quota_snapshots_envelope_object_check
    check (pg_catalog.jsonb_typeof(envelope) = 'object'),
  constraint quota_snapshots_expiry_check
    check (expires_at = updated_at + interval '24 hours')
);

create index quota_snapshots_expires_at_idx
  on private.quota_snapshots (expires_at);

alter table private.quota_snapshot_state enable row level security;
alter table private.quota_snapshot_state force row level security;
alter table private.quota_snapshots enable row level security;
alter table private.quota_snapshots force row level security;

drop policy if exists quota_snapshot_state_select_own on private.quota_snapshot_state;
create policy quota_snapshot_state_select_own
  on private.quota_snapshot_state
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists quota_snapshots_select_own on private.quota_snapshots;
create policy quota_snapshots_select_own
  on private.quota_snapshots
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Tables stay outside the exposed schemas and have no client grants. The
-- SELECT-only RLS policies are defense in depth if a future migration grants
-- read access accidentally; there are deliberately no write policies.
revoke all on table private.quota_snapshot_state
  from public, anon, authenticated, service_role;
revoke all on table private.quota_snapshots
  from public, anon, authenticated, service_role;

create or replace function private.quota_snapshot_fail_v1(p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_reason not in (
    'unsupported_transport',
    'invalid_epoch',
    'stale_epoch',
    'invalid_payload',
    'payload_too_large'
  ) then
    p_reason := 'invalid_payload';
  end if;
  raise exception using
    errcode = '22023',
    message = 'quota_snapshot_' || p_reason;
end;
$$;

create or replace function private.quota_snapshot_text_valid_v1(
  p_value jsonb,
  p_max_bytes integer,
  p_nonempty boolean default true
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p_value) = 'string'
    and pg_catalog.octet_length(p_value #>> '{}') <= p_max_bytes
    and (not p_nonempty or pg_catalog.octet_length(p_value #>> '{}') > 0),
    false
  );
$$;

create or replace function private.quota_snapshot_integer_valid_v1(
  p_value jsonb,
  p_min bigint,
  p_max bigint
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_value numeric;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'number' then
    return false;
  end if;
  v_value := (p_value #>> '{}')::numeric;
  return v_value = pg_catalog.trunc(v_value)
    and v_value between p_min::numeric and p_max::numeric;
exception when others then
  return false;
end;
$$;

create or replace function private.quota_snapshot_number_valid_v1(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_value numeric;
  v_abs numeric;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'number' then
    return false;
  end if;
  v_value := (p_value #>> '{}')::numeric;
  v_abs := pg_catalog.abs(v_value);
  return v_abs <= '1.7976931348623157e308'::numeric
    and (v_value = 0 or v_abs >= '4.9406564584124654e-324'::numeric);
exception when others then
  return false;
end;
$$;

create or replace function private.quota_snapshot_timestamp_valid_v1(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_text text;
  v_year integer;
  v_month integer;
  v_day integer;
  v_hour integer;
  v_minute integer;
  v_second integer;
  v_offset_hour integer := 0;
  v_offset_minute integer := 0;
begin
  if not private.quota_snapshot_text_valid_v1(p_value, 512, true) then
    return false;
  end if;
  v_text := p_value #>> '{}';
  if v_text !~* '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    return false;
  end if;

  v_year := pg_catalog.substr(v_text, 1, 4)::integer;
  v_month := pg_catalog.substr(v_text, 6, 2)::integer;
  v_day := pg_catalog.substr(v_text, 9, 2)::integer;
  v_hour := pg_catalog.substr(v_text, 12, 2)::integer;
  v_minute := pg_catalog.substr(v_text, 15, 2)::integer;
  v_second := pg_catalog.substr(v_text, 18, 2)::integer;
  if pg_catalog.right(v_text, 1) not in ('Z', 'z') then
    v_offset_hour := pg_catalog.substr(v_text, pg_catalog.length(v_text) - 4, 2)::integer;
    v_offset_minute := pg_catalog.right(v_text, 2)::integer;
  end if;
  perform pg_catalog.make_date(v_year, v_month, v_day);
  return v_year >= 1
    and v_hour between 0 and 23
    and v_minute between 0 and 59
    and v_second between 0 and 59
    and v_offset_hour between 0 and 23
    and v_offset_minute between 0 and 59;
exception when others then
  return false;
end;
$$;

create or replace function private.quota_snapshot_reason_valid_v1(p_reason text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_reason = any(array[
    'local_authorization_required',
    'app_server_unavailable',
    'app_server_timeout',
    'app_server_auth_required',
    'consumer_api_unavailable',
    'source_not_found',
    'permission_denied',
    'source_schema_unsupported',
    'source_scan_truncated',
    'source_temporarily_unavailable',
    'provider_worker_failed',
    'provider_cache_unavailable',
    'claude_statusline_authorization_required',
    'claude_statusline_snapshot_missing',
    'claude_statusline_snapshot_invalid',
    'observation_stale',
    'credits_unlimited',
    'admin_key_required',
    'rate_limited',
    'upstream_unavailable'
  ]::text[]);
$$;

create or replace function private.validate_quota_snapshots_v1(p_providers jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_envelope jsonb;
  v_window jsonb;
  v_provider_id text;
  v_scope text;
  v_mode text;
  v_capability text;
  v_status text;
  v_reason text;
  v_provider_key text;
  v_provider_keys text[] := array[]::text[];
  v_window_id text;
  v_window_ids text[];
  v_source text;
  v_window_status text;
  v_unit text;
  v_used numeric;
  v_limit numeric;
  v_remaining numeric;
  v_scale numeric;
  v_window_count integer;
  v_has_fresh boolean;
  v_has_stale boolean;
  v_has_used boolean;
  v_has_limit boolean;
  v_has_remaining boolean;
begin
  if p_providers is null or pg_catalog.jsonb_typeof(p_providers) <> 'array' then
    perform private.quota_snapshot_fail_v1('invalid_payload');
  end if;
  if pg_catalog.jsonb_array_length(p_providers) > 8 then
    perform private.quota_snapshot_fail_v1('invalid_payload');
  end if;

  for v_envelope in
    select e.value from pg_catalog.jsonb_array_elements(p_providers) as e(value)
  loop
    if pg_catalog.jsonb_typeof(v_envelope) <> 'object'
       or not (v_envelope ?& array[
         'schemaVersion', 'providerId', 'displayName', 'scope', 'mode',
         'capability', 'status', 'windows'
       ]::text[])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_envelope) as k(key)
         where not (k.key = any(array[
           'schemaVersion', 'providerId', 'displayName', 'scope', 'mode',
           'capability', 'status', 'windows', 'reasonCode'
         ]::text[]))
       ) then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;

    if not private.quota_snapshot_integer_valid_v1(v_envelope -> 'schemaVersion', 1, 1)
       or not private.quota_snapshot_text_valid_v1(v_envelope -> 'providerId', 128, true)
       or not private.quota_snapshot_text_valid_v1(v_envelope -> 'displayName', 512, true)
       or not private.quota_snapshot_text_valid_v1(v_envelope -> 'scope', 512, true)
       or not private.quota_snapshot_text_valid_v1(v_envelope -> 'mode', 512, true)
       or not private.quota_snapshot_text_valid_v1(v_envelope -> 'capability', 512, true)
       or not private.quota_snapshot_text_valid_v1(v_envelope -> 'status', 512, true)
       or pg_catalog.jsonb_typeof(v_envelope -> 'windows') <> 'array' then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;

    v_provider_id := v_envelope ->> 'providerId';
    v_scope := v_envelope ->> 'scope';
    v_mode := v_envelope ->> 'mode';
    v_capability := v_envelope ->> 'capability';
    v_status := v_envelope ->> 'status';
    v_reason := null;
    if v_envelope ? 'reasonCode' then
      if not private.quota_snapshot_text_valid_v1(v_envelope -> 'reasonCode', 512, true) then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;
      v_reason := v_envelope ->> 'reasonCode';
      if not private.quota_snapshot_reason_valid_v1(v_reason) then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;
    end if;

    if v_scope not in ('consumer-subscription', 'api-organization', 'manual-budget')
       or v_mode not in ('automatic', 'manual', 'unsupported')
       or v_capability not in ('stable', 'plan-dependent', 'experimental', 'manual', 'unsupported')
       or v_status not in ('ok', 'stale', 'unsupported', 'auth-required', 'error') then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;

    v_provider_key := pg_catalog.jsonb_build_array(v_provider_id, v_scope)::text;
    if v_provider_key = any(v_provider_keys) then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;
    v_provider_keys := pg_catalog.array_append(v_provider_keys, v_provider_key);

    v_window_count := pg_catalog.jsonb_array_length(v_envelope -> 'windows');
    if v_window_count > 16 then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;
    if v_status = 'unsupported' then
      if v_window_count <> 0 or v_mode <> 'unsupported'
         or v_capability <> 'unsupported' or v_reason is null then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;
    elsif v_mode = 'unsupported' or v_capability = 'unsupported' then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;
    if v_status in ('auth-required', 'error') and v_window_count <> 0 then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;
    if v_status in ('ok', 'stale') and v_window_count = 0 then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;
    if (v_scope = 'manual-budget') <> (v_mode = 'manual') then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;
    if (v_mode = 'manual') <> (v_capability = 'manual') then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;

    v_window_ids := array[]::text[];
    v_has_fresh := false;
    v_has_stale := false;
    for v_window in
      select w.value from pg_catalog.jsonb_array_elements(v_envelope -> 'windows') as w(value)
    loop
      if pg_catalog.jsonb_typeof(v_window) <> 'object'
         or not (v_window ?& array[
           'providerId', 'windowId', 'windowLabel', 'scope', 'source', 'status',
           'unit', 'observedAt', 'fetchedAt', 'staleAfterSeconds'
         ]::text[])
         or exists (
           select 1
           from pg_catalog.jsonb_object_keys(v_window) as k(key)
           where not (k.key = any(array[
             'providerId', 'windowId', 'windowLabel', 'scope', 'source', 'status',
             'used', 'limit', 'remaining', 'unit', 'windowMinutes', 'resetsAt',
             'observedAt', 'fetchedAt', 'staleAfterSeconds', 'reasonCode'
           ]::text[]))
         ) then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;

      if not private.quota_snapshot_text_valid_v1(v_window -> 'providerId', 128, true)
         or not private.quota_snapshot_text_valid_v1(v_window -> 'windowId', 128, true)
         or not private.quota_snapshot_text_valid_v1(v_window -> 'windowLabel', 512, true)
         or not private.quota_snapshot_text_valid_v1(v_window -> 'scope', 512, true)
         or not private.quota_snapshot_text_valid_v1(v_window -> 'source', 512, true)
         or not private.quota_snapshot_text_valid_v1(v_window -> 'status', 512, true)
         or not private.quota_snapshot_text_valid_v1(v_window -> 'unit', 512, true)
         or not private.quota_snapshot_timestamp_valid_v1(v_window -> 'observedAt')
         or not private.quota_snapshot_timestamp_valid_v1(v_window -> 'fetchedAt')
         or not private.quota_snapshot_integer_valid_v1(
           v_window -> 'staleAfterSeconds', 1, 2147483647
         ) then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;

      v_window_id := v_window ->> 'windowId';
      v_source := v_window ->> 'source';
      v_window_status := v_window ->> 'status';
      v_unit := v_window ->> 'unit';
      if v_window ->> 'providerId' <> v_provider_id
         or v_window ->> 'scope' <> v_scope
         or v_window_id = any(v_window_ids)
         or v_source not in ('official-api', 'local-authorized', 'manual')
         or v_window_status not in ('ok', 'stale', 'auth-required', 'error')
         or v_unit not in ('percent', 'requests', 'tokens', 'usd', 'credits') then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;
      v_window_ids := pg_catalog.array_append(v_window_ids, v_window_id);

      if (v_mode = 'manual') <> (v_source = 'manual')
         or (v_scope = 'api-organization' and v_source <> 'official-api')
         or (v_scope = 'consumer-subscription' and v_source <> 'local-authorized') then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;

      if v_window ? 'windowMinutes'
         and not private.quota_snapshot_integer_valid_v1(
           v_window -> 'windowMinutes', 1, 2147483647
         ) then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;
      if v_window ? 'resetsAt'
         and not private.quota_snapshot_timestamp_valid_v1(v_window -> 'resetsAt') then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;

      v_reason := null;
      if v_window ? 'reasonCode' then
        if not private.quota_snapshot_text_valid_v1(v_window -> 'reasonCode', 512, true) then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
        v_reason := v_window ->> 'reasonCode';
        if not private.quota_snapshot_reason_valid_v1(v_reason) then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
      end if;

      v_has_used := v_window ? 'used';
      v_has_limit := v_window ? 'limit';
      v_has_remaining := v_window ? 'remaining';
      v_used := null;
      v_limit := null;
      v_remaining := null;
      if v_has_used then
        if not private.quota_snapshot_number_valid_v1(v_window -> 'used') then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
        v_used := (v_window ->> 'used')::numeric;
      end if;
      if v_has_limit then
        if not private.quota_snapshot_number_valid_v1(v_window -> 'limit') then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
        v_limit := (v_window ->> 'limit')::numeric;
      end if;
      if v_has_remaining then
        if not private.quota_snapshot_number_valid_v1(v_window -> 'remaining') then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
        v_remaining := (v_window ->> 'remaining')::numeric;
      end if;
      if coalesce(v_used < 0, false) or coalesce(v_limit < 0, false)
         or coalesce(v_remaining < 0, false) then
        perform private.quota_snapshot_fail_v1('invalid_payload');
      end if;

      if v_reason = 'credits_unlimited' then
        if v_window_status not in ('ok', 'stale') or v_unit <> 'credits'
           or v_has_used or v_has_limit or v_has_remaining then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
      elsif v_window_status in ('auth-required', 'error') then
        if v_has_used or v_has_limit or v_has_remaining then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
      elsif v_unit = 'percent' then
        if not v_has_used or v_used > 100
           or (v_has_limit and v_limit <> 100)
           or (v_has_remaining and v_remaining > 100) then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
        if v_has_remaining then
          v_scale := greatest(1::numeric, pg_catalog.abs(v_remaining), pg_catalog.abs(100 - v_used));
          if pg_catalog.abs(v_remaining - (100 - v_used))
             > '2.220446049250313e-16'::numeric * v_scale * 16 then
            perform private.quota_snapshot_fail_v1('invalid_payload');
          end if;
        end if;
      else
        if not (v_has_used or v_has_limit or v_has_remaining)
           or (v_has_used and v_has_limit and v_used > v_limit)
           or (v_has_limit and v_has_remaining and v_remaining > v_limit) then
          perform private.quota_snapshot_fail_v1('invalid_payload');
        end if;
        if v_has_used and v_has_limit and v_has_remaining then
          v_scale := greatest(
            1::numeric,
            pg_catalog.abs(v_remaining),
            pg_catalog.abs(v_limit - v_used)
          );
          if pg_catalog.abs(v_remaining - (v_limit - v_used))
             > '2.220446049250313e-16'::numeric * v_scale * 16 then
            perform private.quota_snapshot_fail_v1('invalid_payload');
          end if;
        end if;
      end if;

      v_has_fresh := v_has_fresh or v_window_status = 'ok';
      v_has_stale := v_has_stale or v_window_status = 'stale';
    end loop;

    if (v_status = 'ok' and not v_has_fresh)
       or (v_status = 'stale' and not v_has_stale) then
      perform private.quota_snapshot_fail_v1('invalid_payload');
    end if;
  end loop;
end;
$$;

create or replace function private.purge_expired_quota_snapshots_v1()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  delete from private.quota_snapshots
  where expires_at <= pg_catalog.clock_timestamp();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.replace_quota_snapshots_v1(
  p_transport_version integer,
  p_epoch bigint,
  p_providers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_epoch bigint;
  v_revision bigint;
  v_now timestamptz;
  v_count integer;
begin
  if v_user is null or not exists (select 1 from auth.users where id = v_user) then
    raise exception using errcode = '42501', message = 'quota_snapshot_identity_required';
  end if;

  insert into private.quota_snapshot_state (user_id)
  values (v_user)
  on conflict (user_id) do nothing;

  select epoch, revision into strict v_epoch, v_revision
  from private.quota_snapshot_state
  where user_id = v_user
  for update;

  if p_transport_version is distinct from 1 then
    perform private.quota_snapshot_fail_v1('unsupported_transport');
  end if;
  if p_epoch is null or p_epoch < 0 or p_epoch > 9007199254740991 then
    perform private.quota_snapshot_fail_v1('invalid_epoch');
  end if;
  if p_providers is null or pg_catalog.jsonb_typeof(p_providers) <> 'array' then
    perform private.quota_snapshot_fail_v1('invalid_payload');
  end if;
  if pg_catalog.octet_length(p_providers::text) > 65536 then
    perform private.quota_snapshot_fail_v1('payload_too_large');
  end if;
  perform private.validate_quota_snapshots_v1(p_providers);

  if p_epoch <> v_epoch then
    perform private.quota_snapshot_fail_v1('stale_epoch');
  end if;
  if v_revision >= 9007199254740991 then
    perform private.quota_snapshot_fail_v1('unsupported_transport');
  end if;

  v_now := pg_catalog.clock_timestamp();
  delete from private.quota_snapshots where user_id = v_user;
  insert into private.quota_snapshots (
    user_id, provider_id, scope, sort_order, envelope, updated_at, expires_at
  )
  select
    v_user,
    e.value ->> 'providerId',
    e.value ->> 'scope',
    e.ordinality::smallint,
    e.value,
    v_now,
    v_now + interval '24 hours'
  from pg_catalog.jsonb_array_elements(p_providers) with ordinality as e(value, ordinality);

  v_count := pg_catalog.jsonb_array_length(p_providers);
  v_revision := v_revision + 1;
  update private.quota_snapshot_state
  set revision = v_revision, updated_at = v_now
  where user_id = v_user;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'transportVersion', 1,
    'epoch', v_epoch,
    'revision', v_revision,
    'replacedProviderCount', v_count,
    'generatedAt', v_now
  );
end;
$$;

create or replace function public.get_quota_snapshots_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_epoch bigint;
  v_revision bigint;
  v_now timestamptz;
  v_providers jsonb;
begin
  if v_user is null or not exists (select 1 from auth.users where id = v_user) then
    raise exception using errcode = '42501', message = 'quota_snapshot_identity_required';
  end if;

  insert into private.quota_snapshot_state (user_id)
  values (v_user)
  on conflict (user_id) do nothing;

  select epoch, revision into strict v_epoch, v_revision
  from private.quota_snapshot_state
  where user_id = v_user
  for update;

  v_now := pg_catalog.clock_timestamp();
  delete from private.quota_snapshots
  where user_id = v_user and expires_at <= v_now;

  select coalesce(
    pg_catalog.jsonb_agg(s.envelope order by s.sort_order),
    '[]'::jsonb
  ) into v_providers
  from private.quota_snapshots s
  where s.user_id = v_user and s.expires_at > v_now;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'transportVersion', 1,
    'epoch', v_epoch,
    'revision', v_revision,
    'generatedAt', v_now,
    'providers', v_providers
  );
end;
$$;

create or replace function public.clear_quota_snapshots_v1(p_transport_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_epoch bigint;
  v_revision bigint;
  v_now timestamptz;
  v_deleted integer;
begin
  if v_user is null or not exists (select 1 from auth.users where id = v_user) then
    raise exception using errcode = '42501', message = 'quota_snapshot_identity_required';
  end if;

  insert into private.quota_snapshot_state (user_id)
  values (v_user)
  on conflict (user_id) do nothing;

  select epoch, revision into strict v_epoch, v_revision
  from private.quota_snapshot_state
  where user_id = v_user
  for update;

  if p_transport_version is distinct from 1 then
    perform private.quota_snapshot_fail_v1('unsupported_transport');
  end if;
  if v_epoch >= 9007199254740991 or v_revision >= 9007199254740991 then
    perform private.quota_snapshot_fail_v1('unsupported_transport');
  end if;

  v_now := pg_catalog.clock_timestamp();
  delete from private.quota_snapshots where user_id = v_user;
  get diagnostics v_deleted = row_count;
  v_epoch := v_epoch + 1;
  v_revision := v_revision + 1;
  update private.quota_snapshot_state
  set epoch = v_epoch, revision = v_revision, updated_at = v_now
  where user_id = v_user;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'transportVersion', 1,
    'epoch', v_epoch,
    'revision', v_revision,
    'clearedProviderCount', v_deleted,
    'generatedAt', v_now
  );
end;
$$;

revoke execute on function private.quota_snapshot_fail_v1(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_text_valid_v1(jsonb, integer, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_integer_valid_v1(jsonb, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_number_valid_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_timestamp_valid_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_reason_valid_v1(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.validate_quota_snapshots_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.purge_expired_quota_snapshots_v1()
  from public, anon, authenticated, service_role;

revoke execute on function public.replace_quota_snapshots_v1(integer, bigint, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_quota_snapshots_v1()
  from public, anon, authenticated, service_role;
revoke execute on function public.clear_quota_snapshots_v1(integer)
  from public, anon, authenticated, service_role;

grant execute on function public.replace_quota_snapshots_v1(integer, bigint, jsonb)
  to authenticated;
grant execute on function public.get_quota_snapshots_v1()
  to authenticated;
grant execute on function public.clear_quota_snapshots_v1(integer)
  to authenticated;

select cron.schedule(
  'tokenledger-quota-snapshot-hourly-purge',
  '0 * * * *',
  $cron$select private.purge_expired_quota_snapshots_v1();$cron$
);

comment on function public.replace_quota_snapshots_v1(integer, bigint, jsonb)
  is 'Atomically replace the authenticated owner quota snapshot set for a matching epoch.';
comment on function public.get_quota_snapshots_v1()
  is 'Read the authenticated owner unexpired quota snapshot projection.';
comment on function public.clear_quota_snapshots_v1(integer)
  is 'Clear the authenticated owner quota snapshots and advance the revocation epoch.';
