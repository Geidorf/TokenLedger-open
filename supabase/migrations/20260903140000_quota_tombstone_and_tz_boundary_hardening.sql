-- Migration: 20260903140000_quota_tombstone_and_tz_boundary_hardening.sql
-- Description (T10.93, corrected by T10.95):
--   1. public.upsert_quota_snapshots_v2 — the 8-provider cap no longer counts
--      soft-deleted tombstones (a user who deleted 8 provider identities was
--      locked out forever), and an incoming observedAt more than 5 minutes in
--      the future is clamped to the server clock so a drifted device cannot pin
--      a provider permanently (review #13).
--   2. public.request_refresh() — 60 second global cooldown so any single
--      authenticated user cannot trigger back-to-back rebuilds of the
--      cross-tenant materialized views (review #12).
--
-- Both functions are re-created from their 20260717172408 / 20260611033024
-- bodies with the minimal edits above: parameter names, reason codes, payload
-- shape, search_path and grants are unchanged (CREATE OR REPLACE refuses to
-- rename input parameters, and PostgREST resolves RPC arguments by name).
--
-- Tombstones are intentionally NOT garbage-collected: the cap fix removes the
-- lock-out without giving a device that has not synced for weeks a window to
-- resurrect a deleted provider. private.purge_expired_quota_snapshots_v1()
-- stays the no-op that 20260717172408 made it.

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

create or replace function public.request_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dirty_start bigint;
  v_refreshed_start bigint;
  v_dirty_finished bigint;
  v_refreshed_finished bigint;
  v_last_refreshed timestamptz;
  v_started timestamptz;
  v_finished timestamptz;
begin
  if not pg_try_advisory_xact_lock(917341106045) then
    return jsonb_build_object(
      'refreshed', false,
      'reason', 'refreshing',
      'stale', true,
      'finished_at', now()
    );
  end if;

  select dirty_generation, refreshed_generation, last_refreshed_at
    into v_dirty_start, v_refreshed_start, v_last_refreshed
    from public.sync_state
   where id = 1;

  if v_dirty_start is null then
    insert into public.sync_state (id, is_dirty, dirty_generation, refreshed_generation)
    values (1, true, 1, 0)
    on conflict (id) do nothing;

    select dirty_generation, refreshed_generation, last_refreshed_at
      into v_dirty_start, v_refreshed_start, v_last_refreshed
      from public.sync_state
     where id = 1;
  end if;

  if v_dirty_start <= v_refreshed_start then
    return jsonb_build_object(
      'refreshed', false,
      'reason', 'clean',
      'stale', false,
      'dirty_generation', v_dirty_start,
      'refreshed_generation', v_refreshed_start,
      'finished_at', now()
    );
  end if;

  -- T10.93/T10.95 (#12): every authenticated user may call this, and every
  -- call rebuilds the cross-tenant summaries. Bound the rebuild rate globally;
  -- callers see the same "stale" signal they already handle.
  if v_last_refreshed is not null
     and clock_timestamp() - v_last_refreshed < interval '60 seconds' then
    return jsonb_build_object(
      'refreshed', false,
      'reason', 'cooldown',
      'stale', true,
      'dirty_generation', v_dirty_start,
      'refreshed_generation', v_refreshed_start,
      'finished_at', v_last_refreshed
    );
  end if;

  v_started := clock_timestamp();
  perform public.refresh_token_logs_summaries();
  v_finished := clock_timestamp();

  update public.sync_state
     set refreshed_generation = greatest(refreshed_generation, v_dirty_start),
         is_dirty = dirty_generation > greatest(refreshed_generation, v_dirty_start),
         last_refreshed_at = v_finished
   where id = 1;

  select dirty_generation, refreshed_generation
    into v_dirty_finished, v_refreshed_finished
    from public.sync_state
   where id = 1;

  return jsonb_build_object(
    'refreshed', true,
    'stale', v_dirty_finished > v_refreshed_finished,
    'dirty_generation', v_dirty_finished,
    'refreshed_generation', v_refreshed_finished,
    'started_at', v_started,
    'finished_at', v_finished,
    'duration_ms', (extract(epoch from (v_finished - v_started)) * 1000)::bigint
  );
end;
$$;
