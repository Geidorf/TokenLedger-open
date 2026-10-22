-- TokenLedger durable, owner-scoped quota snapshot transport v2.
--
-- Provider envelope schema remains quota-provider-v1. Transport v2 changes
-- persistence from 24-hour full-set replacement to per-provider latest-wins
-- upserts. Explicit deletes advance a provider generation (or the global
-- epoch) so requests that were already in flight cannot recreate deleted data.

alter table private.quota_snapshots
  drop constraint quota_snapshots_expiry_check;

alter table private.quota_snapshots
  alter column envelope drop not null,
  alter column expires_at drop not null,
  add column generation bigint not null default 0,
  add column source_observed_at timestamptz,
  add column received_at timestamptz,
  add column deleted_at timestamptz,
  add constraint quota_snapshots_generation_range_v2
    check (generation between 0 and 9007199254740991);

update private.quota_snapshots s
set
  source_observed_at = case
    when s.envelope ->> 'status' in ('ok', 'stale')
      and pg_catalog.jsonb_array_length(s.envelope -> 'windows') > 0
    then (
      select pg_catalog.max((w.value ->> 'observedAt')::timestamptz)
      from pg_catalog.jsonb_array_elements(s.envelope -> 'windows') as w(value)
    )
    else null
  end,
  received_at = s.updated_at,
  deleted_at = case
    when s.envelope ->> 'status' in ('ok', 'stale')
      and pg_catalog.jsonb_array_length(s.envelope -> 'windows') > 0
    then null
    else s.updated_at
  end,
  envelope = case
    when s.envelope ->> 'status' in ('ok', 'stale')
      and pg_catalog.jsonb_array_length(s.envelope -> 'windows') > 0
    then s.envelope
    else null
  end,
  expires_at = null;

alter table private.quota_snapshots
  alter column received_at set not null,
  alter column received_at set default pg_catalog.clock_timestamp(),
  add constraint quota_snapshots_active_or_tombstone_v2 check (
    (
      deleted_at is null
      and envelope is not null
      and source_observed_at is not null
    ) or (
      deleted_at is not null
      and envelope is null
      and source_observed_at is null
    )
  );

drop index private.quota_snapshots_expires_at_idx;

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'tokenledger-quota-snapshot-hourly-purge';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
end;
$$;

create or replace function private.quota_snapshot_fail_v2(p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_reason not in (
    'unsupported_transport',
    'invalid_epoch',
    'stale_epoch',
    'invalid_provider_generation',
    'stale_provider_generation',
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

create or replace function private.quota_snapshot_source_observed_at_v2(p_envelope jsonb)
returns timestamptz
language plpgsql
stable
parallel safe
set search_path = ''
as $$
declare
  v_observed timestamptz;
begin
  if p_envelope ->> 'status' not in ('ok', 'stale')
     or pg_catalog.jsonb_typeof(p_envelope -> 'windows') <> 'array'
     or pg_catalog.jsonb_array_length(p_envelope -> 'windows') = 0 then
    return null;
  end if;
  select pg_catalog.max((w.value ->> 'observedAt')::timestamptz)
  into v_observed
  from pg_catalog.jsonb_array_elements(p_envelope -> 'windows') as w(value);
  return v_observed;
exception when others then
  return null;
end;
$$;

create or replace function private.validate_quota_snapshot_entries_v2(p_entries jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_envelopes jsonb := '[]'::jsonb;
begin
  if p_entries is null or pg_catalog.jsonb_typeof(p_entries) <> 'array'
     or pg_catalog.jsonb_array_length(p_entries) > 8 then
    perform private.quota_snapshot_fail_v2('invalid_payload');
  end if;
  for v_entry in
    select e.value from pg_catalog.jsonb_array_elements(p_entries) as e(value)
  loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
       or not (v_entry ?& array['generation', 'envelope']::text[])
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_entry) as k(key)
         where k.key not in ('generation', 'envelope')
       )
       or not private.quota_snapshot_integer_valid_v1(
         v_entry -> 'generation', 0, 9007199254740991
       )
       or pg_catalog.jsonb_typeof(v_entry -> 'envelope') <> 'object' then
      perform private.quota_snapshot_fail_v2('invalid_payload');
    end if;
    v_envelopes := v_envelopes || pg_catalog.jsonb_build_array(v_entry -> 'envelope');
  end loop;
  perform private.validate_quota_snapshots_v1(v_envelopes);
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_envelopes) as e(value)
    where e.value ->> 'status' not in ('ok', 'stale')
       or private.quota_snapshot_source_observed_at_v2(e.value) is null
  ) then
    perform private.quota_snapshot_fail_v2('invalid_payload');
  end if;
end;
$$;

create or replace function private.quota_snapshot_payload_v2(
  p_user uuid,
  p_epoch bigint,
  p_revision bigint,
  p_now timestamptz
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_providers jsonb;
  v_states jsonb;
begin
  select coalesce(
    pg_catalog.jsonb_agg(s.envelope order by s.provider_id, s.scope),
    '[]'::jsonb
  ) into v_providers
  from private.quota_snapshots s
  where s.user_id = p_user and s.deleted_at is null;

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
  where s.user_id = p_user;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'transportVersion', 2,
    'epoch', p_epoch,
    'revision', p_revision,
    'generatedAt', p_now,
    'providers', v_providers,
    'providerStates', v_states
  );
end;
$$;

create or replace function public.get_quota_snapshots_v2()
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
  return private.quota_snapshot_payload_v2(v_user, v_epoch, v_revision, v_now);
end;
$$;

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
      if (select pg_catalog.count(*) from private.quota_snapshots where user_id = v_user) >= 8 then
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

create or replace function public.delete_quota_snapshot_provider_v2(
  p_transport_version integer,
  p_epoch bigint,
  p_provider_id text,
  p_scope text,
  p_generation bigint
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
  v_current_generation bigint;
  v_row_exists boolean;
  v_next_generation bigint;
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
  if not private.quota_snapshot_text_valid_v1(pg_catalog.to_jsonb(p_provider_id), 128, true)
     or p_scope not in ('consumer-subscription', 'api-organization', 'manual-budget')
     or p_generation is null or p_generation < 0
     or p_generation > 9007199254740991 then
    perform private.quota_snapshot_fail_v2('invalid_payload');
  end if;

  select true, s.generation into v_row_exists, v_current_generation
  from private.quota_snapshots s
  where s.user_id = v_user and s.provider_id = p_provider_id and s.scope = p_scope
  for update;
  if coalesce(v_row_exists, false) and p_generation < v_current_generation then
    perform private.quota_snapshot_fail_v2('stale_provider_generation');
  end if;
  if coalesce(v_row_exists, false) and p_generation > v_current_generation then
    perform private.quota_snapshot_fail_v2('invalid_provider_generation');
  end if;
  if not coalesce(v_row_exists, false) and p_generation <> 0 then
    perform private.quota_snapshot_fail_v2('invalid_provider_generation');
  end if;
  if not coalesce(v_row_exists, false)
     and (select pg_catalog.count(*) from private.quota_snapshots where user_id = v_user) >= 8 then
    perform private.quota_snapshot_fail_v2('invalid_payload');
  end if;
  if coalesce(v_current_generation, 0) >= 9007199254740991
     or v_revision >= 9007199254740991 then
    perform private.quota_snapshot_fail_v2('unsupported_transport');
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_next_generation := coalesce(v_current_generation, 0) + 1;
  insert into private.quota_snapshots (
    user_id, provider_id, scope, sort_order, envelope, updated_at, expires_at,
    generation, source_observed_at, received_at, deleted_at
  ) values (
    v_user, p_provider_id, p_scope, 1, null, v_now, null,
    v_next_generation, null, v_now, v_now
  )
  on conflict (user_id, provider_id, scope) do update
  set envelope = null,
      source_observed_at = null,
      received_at = excluded.received_at,
      updated_at = excluded.updated_at,
      expires_at = null,
      generation = excluded.generation,
      deleted_at = excluded.deleted_at;
  v_revision := v_revision + 1;
  update private.quota_snapshot_state
  set revision = v_revision, updated_at = v_now
  where user_id = v_user;

  v_payload := private.quota_snapshot_payload_v2(v_user, v_epoch, v_revision, v_now);
  return v_payload || pg_catalog.jsonb_build_object(
    'deletedProviderId', p_provider_id,
    'deletedScope', p_scope,
    'providerGeneration', v_next_generation
  );
end;
$$;

create or replace function public.clear_quota_snapshots_v2(
  p_transport_version integer,
  p_epoch bigint
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
  v_cleared integer;
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
  if v_epoch >= 9007199254740991 or v_revision >= 9007199254740991
     or exists (
       select 1 from private.quota_snapshots
       where user_id = v_user and generation >= 9007199254740991
     ) then
    perform private.quota_snapshot_fail_v2('unsupported_transport');
  end if;

  v_now := pg_catalog.clock_timestamp();
  select pg_catalog.count(*)::integer into v_cleared
  from private.quota_snapshots
  where user_id = v_user and deleted_at is null;
  update private.quota_snapshots
  set generation = generation + 1,
      envelope = null,
      source_observed_at = null,
      received_at = v_now,
      updated_at = v_now,
      expires_at = null,
      deleted_at = v_now
  where user_id = v_user;
  v_epoch := v_epoch + 1;
  v_revision := v_revision + 1;
  update private.quota_snapshot_state
  set epoch = v_epoch, revision = v_revision, updated_at = v_now
  where user_id = v_user;

  v_payload := private.quota_snapshot_payload_v2(v_user, v_epoch, v_revision, v_now);
  return v_payload || pg_catalog.jsonb_build_object('clearedProviderCount', v_cleared);
end;
$$;

-- Legacy v1 readers receive the same durable active rows, without the v2
-- generation metadata. This keeps already-installed Android clients useful.
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
  where s.user_id = v_user and s.deleted_at is null;
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

-- Legacy replacement becomes additive latest-wins. It never removes omitted
-- providers and cannot cross a v2 provider tombstone because v1 has no
-- generation proof. The legacy response shape stays unchanged.
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
  v_before_revision bigint;
  v_now timestamptz;
  v_entries jsonb;
  v_result jsonb;
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
  if p_epoch <> v_epoch then
    perform private.quota_snapshot_fail_v1('stale_epoch');
  end if;
  if p_providers is null or pg_catalog.jsonb_typeof(p_providers) <> 'array' then
    perform private.quota_snapshot_fail_v1('invalid_payload');
  end if;
  if pg_catalog.octet_length(p_providers::text) > 65536 then
    perform private.quota_snapshot_fail_v1('payload_too_large');
  end if;
  perform private.validate_quota_snapshots_v1(p_providers);
  v_count := pg_catalog.jsonb_array_length(p_providers);
  v_before_revision := v_revision;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'generation', coalesce(s.generation, 0),
    'envelope', e.value
  )), '[]'::jsonb)
  into v_entries
  from pg_catalog.jsonb_array_elements(p_providers) as e(value)
  left join private.quota_snapshots s
    on s.user_id = v_user
   and s.provider_id = e.value ->> 'providerId'
   and s.scope = e.value ->> 'scope'
  where e.value ->> 'status' in ('ok', 'stale')
    and s.deleted_at is null;
  v_result := public.upsert_quota_snapshots_v2(2, v_epoch, v_entries);
  v_revision := (v_result ->> 'revision')::bigint;
  v_now := pg_catalog.clock_timestamp();
  if v_revision = v_before_revision then
    if v_revision >= 9007199254740991 then
      perform private.quota_snapshot_fail_v1('unsupported_transport');
    end if;
    v_revision := v_revision + 1;
    update private.quota_snapshot_state
    set revision = v_revision, updated_at = v_now
    where user_id = v_user;
  end if;
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

create or replace function private.purge_expired_quota_snapshots_v1()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select 0::bigint;
$$;

revoke execute on function private.quota_snapshot_fail_v2(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_source_observed_at_v2(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.validate_quota_snapshot_entries_v2(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_payload_v2(uuid, bigint, bigint, timestamptz)
  from public, anon, authenticated, service_role;

revoke execute on function public.get_quota_snapshots_v2()
  from public, anon, authenticated, service_role;
revoke execute on function public.upsert_quota_snapshots_v2(integer, bigint, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.delete_quota_snapshot_provider_v2(integer, bigint, text, text, bigint)
  from public, anon, authenticated, service_role;
revoke execute on function public.clear_quota_snapshots_v2(integer, bigint)
  from public, anon, authenticated, service_role;

grant execute on function public.get_quota_snapshots_v2() to authenticated;
grant execute on function public.upsert_quota_snapshots_v2(integer, bigint, jsonb)
  to authenticated;
grant execute on function public.delete_quota_snapshot_provider_v2(integer, bigint, text, text, bigint)
  to authenticated;
grant execute on function public.clear_quota_snapshots_v2(integer, bigint)
  to authenticated;

comment on function public.get_quota_snapshots_v2()
  is 'Read all durable active quota snapshots and per-provider generations for the authenticated owner.';
comment on function public.upsert_quota_snapshots_v2(integer, bigint, jsonb)
  is 'Conditionally upsert owner quota providers by source observed time without deleting omitted providers.';
comment on function public.delete_quota_snapshot_provider_v2(integer, bigint, text, text, bigint)
  is 'Explicitly tombstone one owner quota provider and advance its generation.';
comment on function public.clear_quota_snapshots_v2(integer, bigint)
  is 'Explicitly tombstone all owner quota providers and advance the global epoch.';
