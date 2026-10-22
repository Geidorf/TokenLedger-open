-- T10.307b: keep at most eight active providers when a tombstone is republished.
-- Existing generation/epoch and old-observation guards keep their priority.
-- Only valid, genuinely newer observations reach this active-capacity check.

create or replace function public.upsert_quota_snapshots_v2(
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

  if p_transport_version is distinct from 2 then
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
  perform private.validate_quota_snapshot_entries_v2(p_providers);

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

    -- T10.93/T10.95 (#13): a device with a drifted clock must not be able to
    -- pin a provider with a far-future observedAt. Anything more than five
    -- minutes ahead of the server clock is recorded as observed "now"; honest
    -- uploads that follow can still win latest-wins.
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
      -- T10.93/T10.95 (#13): tombstones are rows too, but they must not count
      -- against the live-provider cap.
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
      -- Tombstones do not occupy capacity, but republishing one adds an active row.
      -- Check only after stale generation/observation requests have been ignored.
      if v_current_deleted and (
        select pg_catalog.count(*)
        from private.quota_snapshots
        where user_id = v_user and deleted_at is null
      ) >= 8 then
        perform private.quota_snapshot_fail_v2('invalid_payload');
      end if;
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

  v_payload := private.quota_snapshot_payload_v2(v_user, v_epoch, v_revision, v_now);
  return v_payload || pg_catalog.jsonb_build_object(
    'upsertedProviderCount', v_upserted,
    'ignoredProviderCount', v_ignored
  );
end;
$$;

revoke execute on function public.upsert_quota_snapshots_v2(integer, bigint, jsonb)
  from public, anon, service_role;
grant execute on function public.upsert_quota_snapshots_v2(integer, bigint, jsonb)
  to authenticated;

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
      -- Tombstones do not occupy capacity, but republishing one adds an active row.
      -- Check only after stale generation/observation requests have been ignored.
      if v_current_deleted and (
        select pg_catalog.count(*)
        from private.quota_snapshots
        where user_id = v_user and deleted_at is null
      ) >= 8 then
        perform private.quota_snapshot_fail_v2('invalid_payload');
      end if;
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

revoke execute on function public.upsert_quota_snapshots_v3(integer, bigint, jsonb)
  from public, anon, service_role;
grant execute on function public.upsert_quota_snapshots_v3(integer, bigint, jsonb)
  to authenticated;
