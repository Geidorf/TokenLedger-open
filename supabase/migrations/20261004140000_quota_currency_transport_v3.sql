-- Migration: 20261004140000_quota_currency_transport_v3.sql
-- Description (T10.284, ADR-018 U-108, quota-provider-v1 §2.2/§6.1/§7):
--   Gated currency unit for quota envelopes. unit='currency' plus an ISO 4217
--   `currency` code is accepted only through the new transport v3 pair:
--     public.get_quota_snapshots_v3()
--     public.upsert_quota_snapshots_v3(integer, bigint, jsonb)
--   Both share rows, epoch, revision, generations and tombstones with v2.
--   Provider delete and global clear keep using the v2 functions.
--
--   Older readers can never receive the new unit:
--     * private.quota_snapshot_payload_v2 (used by every v2 response) now omits
--       envelopes that contain a currency window, together with their
--       providerStates entry, so released v2 clients that require one active
--       state per returned envelope see the Provider as "not synced" instead
--       of rejecting the whole response;
--     * public.get_quota_snapshots_v1 omits the same envelopes;
--     * the v1/v2 write validators are unchanged and keep rejecting the unit.
--
--   Function bodies follow 20260717172408 / 20260903140000 with the minimal
--   edits above; search_path stays empty and every object is schema-qualified.

alter table private.quota_snapshot_state enable row level security;
alter table private.quota_snapshot_state force row level security;
alter table private.quota_snapshots enable row level security;
alter table private.quota_snapshots force row level security;
revoke all on table private.quota_snapshot_state
  from public, anon, authenticated, service_role;
revoke all on table private.quota_snapshots
  from public, anon, authenticated, service_role;

create or replace function private.quota_snapshot_has_currency_v3(p_envelope jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p_envelope -> 'windows') = 'array'
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_envelope -> 'windows') as w(value)
      where pg_catalog.jsonb_typeof(w.value) = 'object'
        and (w.value ->> 'unit' = 'currency' or w.value ? 'currency')
    ),
    false
  );
$$;

-- Checks the §2.2 currency rules, then maps each currency window onto an
-- equivalent absolute-unit window so the unchanged v1/v2 validators enforce
-- every other envelope, arithmetic and status invariant. Only the validator
-- sees the mapped copy; the caller stores the original envelope.
create or replace function private.validate_quota_snapshot_entries_v3(p_entries jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_window jsonb;
  v_windows jsonb;
  v_normalized jsonb := '[]'::jsonb;
begin
  if p_entries is null or pg_catalog.jsonb_typeof(p_entries) <> 'array' then
    perform private.quota_snapshot_fail_v2('invalid_payload');
  end if;
  for v_entry in
    select e.value from pg_catalog.jsonb_array_elements(p_entries) as e(value)
  loop
    if pg_catalog.jsonb_typeof(v_entry) = 'object'
       and pg_catalog.jsonb_typeof(v_entry -> 'envelope') = 'object'
       and pg_catalog.jsonb_typeof(v_entry #> '{envelope,windows}') = 'array' then
      v_windows := '[]'::jsonb;
      for v_window in
        select w.value
        from pg_catalog.jsonb_array_elements(v_entry #> '{envelope,windows}') as w(value)
      loop
        if pg_catalog.jsonb_typeof(v_window) = 'object' then
          if v_window ->> 'unit' = 'currency' then
            if pg_catalog.jsonb_typeof(v_window -> 'currency') is distinct from 'string'
               or not ((v_window ->> 'currency') collate "C" ~ '^[A-Z]{3}$')
               or v_window ? 'windowMinutes'
               or v_window ? 'resetsAt' then
              perform private.quota_snapshot_fail_v2('invalid_payload');
            end if;
            v_window := (v_window - 'currency')
              || pg_catalog.jsonb_build_object('unit', 'usd');
          elsif v_window ? 'currency' then
            perform private.quota_snapshot_fail_v2('invalid_payload');
          end if;
        end if;
        v_windows := v_windows || pg_catalog.jsonb_build_array(v_window);
      end loop;
      v_entry := pg_catalog.jsonb_set(v_entry, '{envelope,windows}', v_windows);
    end if;
    v_normalized := v_normalized || pg_catalog.jsonb_build_array(v_entry);
  end loop;
  perform private.validate_quota_snapshot_entries_v2(v_normalized);
end;
$$;

create or replace function private.quota_snapshot_payload_v3(
  p_user uuid,
  p_epoch bigint,
  p_revision bigint,
  p_now timestamptz,
  p_transport_version integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_providers jsonb;
  v_states jsonb;
  v_include_currency boolean := p_transport_version >= 3;
begin
  select coalesce(
    pg_catalog.jsonb_agg(s.envelope order by s.provider_id, s.scope),
    '[]'::jsonb
  ) into v_providers
  from private.quota_snapshots s
  where s.user_id = p_user
    and s.deleted_at is null
    and (v_include_currency or not private.quota_snapshot_has_currency_v3(s.envelope));

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'providerId', s.provider_id,
        'scope', s.scope,
        'generation', s.generation,
        'deleted', s.deleted_at is not null,
        'sourceObservedAt', s.source_observed_at,
        'receivedAt', s.received_at
      )) order by s.provider_id, s.scope
    ),
    '[]'::jsonb
  ) into v_states
  from private.quota_snapshots s
  where s.user_id = p_user
    and (
      v_include_currency
      or s.envelope is null
      or not private.quota_snapshot_has_currency_v3(s.envelope)
    );

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'transportVersion', p_transport_version,
    'epoch', p_epoch,
    'revision', p_revision,
    'generatedAt', p_now,
    'providers', v_providers,
    'providerStates', v_states
  );
end;
$$;

create or replace function private.quota_snapshot_payload_v2(
  p_user uuid,
  p_epoch bigint,
  p_revision bigint,
  p_now timestamptz
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.quota_snapshot_payload_v3(p_user, p_epoch, p_revision, p_now, 2);
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
  v_now timestamptz := pg_catalog.clock_timestamp();
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
  select coalesce(
    pg_catalog.jsonb_agg(s.envelope order by s.provider_id, s.scope),
    '[]'::jsonb
  ) into v_providers
  from private.quota_snapshots s
  where s.user_id = v_user
    and s.deleted_at is null
    and not private.quota_snapshot_has_currency_v3(s.envelope);
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

create or replace function public.get_quota_snapshots_v3()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_epoch bigint;
  v_revision bigint;
  v_now timestamptz := pg_catalog.clock_timestamp();
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
  return private.quota_snapshot_payload_v3(v_user, v_epoch, v_revision, v_now, 3);
end;
$$;

create or replace function public.upsert_quota_snapshots_v3(
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
  v_entry jsonb;
  v_envelope jsonb;
  v_provider_id text;
  v_scope text;
  v_generation bigint;
  v_current_generation bigint;
  v_current_observed timestamptz;
  v_current_received timestamptz;
  v_current_deleted boolean;
  v_incoming_observed timestamptz;
  v_row_exists boolean;
  v_upserted integer := 0;
  v_ignored integer := 0;
  v_payload jsonb;
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

  if p_transport_version is distinct from 3 then
    perform private.quota_snapshot_fail_v2('unsupported_transport');
  end if;
  if p_epoch is null or p_epoch < 0 or p_epoch > 9007199254740991 then
    perform private.quota_snapshot_fail_v2('invalid_epoch');
  end if;
  if p_epoch <> v_epoch then
    perform private.quota_snapshot_fail_v2('stale_epoch');
  end if;
  if p_providers is null or pg_catalog.jsonb_typeof(p_providers) <> 'array' then
    perform private.quota_snapshot_fail_v2('invalid_payload');
  end if;
  if pg_catalog.octet_length(p_providers::text) > 65536 then
    perform private.quota_snapshot_fail_v2('payload_too_large');
  end if;
  perform private.validate_quota_snapshot_entries_v3(p_providers);

  v_now := pg_catalog.clock_timestamp();
  for v_entry in
    select e.value from pg_catalog.jsonb_array_elements(p_providers) as e(value)
  loop
    v_row_exists := false;
    v_current_generation := null;
    v_current_observed := null;
    v_current_received := null;
    v_current_deleted := false;
    v_generation := (v_entry ->> 'generation')::bigint;
    v_envelope := v_entry -> 'envelope';
    v_provider_id := v_envelope ->> 'providerId';
    v_scope := v_envelope ->> 'scope';
    v_incoming_observed := private.quota_snapshot_source_observed_at_v2(v_envelope);

    if v_incoming_observed is not null
       and v_incoming_observed > v_now + interval '5 minutes' then
      v_incoming_observed := v_now;
    end if;

    select true, s.generation, s.source_observed_at, s.received_at, s.deleted_at is not null
    into v_row_exists, v_current_generation, v_current_observed, v_current_received, v_current_deleted
    from private.quota_snapshots s
    where s.user_id = v_user
      and s.provider_id = v_provider_id
      and s.scope = v_scope
    for update;

    if not coalesce(v_row_exists, false) then
      if v_generation <> 0 then
        perform private.quota_snapshot_fail_v2('invalid_provider_generation');
      end if;
      if (
        select pg_catalog.count(*)
        from private.quota_snapshots
        where user_id = v_user
          and deleted_at is null
      ) >= 8 then
        perform private.quota_snapshot_fail_v2('invalid_payload');
      end if;
      insert into private.quota_snapshots (
        user_id, provider_id, scope, sort_order, envelope, updated_at, expires_at,
        generation, source_observed_at, received_at, deleted_at
      ) values (
        v_user, v_provider_id, v_scope, 1, v_envelope, v_now, null,
        0, v_incoming_observed, v_now, null
      );
      v_upserted := v_upserted + 1;
    elsif v_generation < v_current_generation then
      v_ignored := v_ignored + 1;
    elsif v_generation > v_current_generation then
      perform private.quota_snapshot_fail_v2('invalid_provider_generation');
    elsif v_current_deleted and v_incoming_observed <= v_current_received then
      v_ignored := v_ignored + 1;
    elsif v_current_observed is not null and v_incoming_observed < v_current_observed then
      v_ignored := v_ignored + 1;
    else
      update private.quota_snapshots
      set envelope = v_envelope,
          source_observed_at = v_incoming_observed,
          received_at = v_now,
          updated_at = v_now,
          expires_at = null,
          deleted_at = null
      where user_id = v_user and provider_id = v_provider_id and scope = v_scope;
      v_upserted := v_upserted + 1;
    end if;
  end loop;

  if v_upserted > 0 then
    if v_revision >= 9007199254740991 then
      perform private.quota_snapshot_fail_v2('unsupported_transport');
    end if;
    v_revision := v_revision + 1;
    update private.quota_snapshot_state
    set revision = v_revision, updated_at = v_now
    where user_id = v_user;
  end if;

  v_payload := private.quota_snapshot_payload_v3(v_user, v_epoch, v_revision, v_now, 3);
  return v_payload || pg_catalog.jsonb_build_object(
    'upsertedProviderCount', v_upserted,
    'ignoredProviderCount', v_ignored
  );
end;
$$;

revoke execute on function private.quota_snapshot_has_currency_v3(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.validate_quota_snapshot_entries_v3(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_payload_v3(uuid, bigint, bigint, timestamptz, integer)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_payload_v2(uuid, bigint, bigint, timestamptz)
  from public, anon, authenticated, service_role;

revoke execute on function public.get_quota_snapshots_v1()
  from public, anon, service_role;
grant execute on function public.get_quota_snapshots_v1() to authenticated;

revoke execute on function public.get_quota_snapshots_v3()
  from public, anon, authenticated, service_role;
revoke execute on function public.upsert_quota_snapshots_v3(integer, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.get_quota_snapshots_v3() to authenticated;
grant execute on function public.upsert_quota_snapshots_v3(integer, bigint, jsonb)
  to authenticated;

comment on function public.get_quota_snapshots_v3()
  is 'Read all durable active quota snapshots, including gated currency windows, for the authenticated owner (transport v3).';
comment on function public.upsert_quota_snapshots_v3(integer, bigint, jsonb)
  is 'Conditionally upsert owner quota providers, accepting gated currency windows (transport v3).';
