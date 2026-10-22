\set ON_ERROR_STOP on

-- Only anonymous synthetic identities and owner-scoped RPCs; all data rolls back.
-- Invoke with psql -v capacity_fixture="$(cat fixtures/quota-provider-v1/transport-capacity-v1.json)" -f this-file.
begin;
create temporary table quota_capacity_fixture(payload jsonb not null) on commit drop;
insert into quota_capacity_fixture values (:'capacity_fixture'::jsonb);
grant select on quota_capacity_fixture to authenticated;
insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '77777777-7777-4777-8777-777777777777', 'quota-capacity@example.invalid',
  pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
);
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', true);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_fixture jsonb := (select payload from quota_capacity_fixture limit 1);
  v_version integer;
  v_epoch bigint;
  v_read jsonb;
  v_entries jsonb;
  v_first jsonb := v_fixture #> '{sqlInitialProviders,0}';
  v_replacement jsonb := v_fixture -> 'sqlReplacementProvider';
  v_generation bigint;
  v_newer jsonb;
  v_rejected boolean;
  v_before jsonb;
  v_active jsonb;
  v_active_generation bigint;
begin
  foreach v_version in array array[2,3] loop
    v_read := public.get_quota_snapshots_v2();
    v_epoch := (v_read ->> 'epoch')::bigint;
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('generation', 0, 'envelope', item))
      into v_entries from pg_catalog.jsonb_array_elements(v_fixture -> 'sqlInitialProviders') item;
    -- Clear from the preceding version leaves generations in tombstones, so read them explicitly.
    if v_version = 3 then
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'generation', (state ->> 'generation')::bigint, 'envelope', provider))
      into v_entries
      from pg_catalog.jsonb_array_elements(v_fixture -> 'sqlInitialProviders') provider
      join pg_catalog.jsonb_array_elements(v_read -> 'providerStates') state
        on state ->> 'providerId' = provider ->> 'providerId';
      -- Genuine observations after clear may republish using current generation.
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(item, '{envelope,windows,0,observedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
        '{envelope,windows,0,fetchedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '2 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))))
      into v_entries from pg_catalog.jsonb_array_elements(v_entries) item;
    end if;
    if v_version = 2 then
      v_read := public.upsert_quota_snapshots_v2(2, v_epoch, v_entries);
    else
      v_read := public.upsert_quota_snapshots_v3(3, v_epoch, v_entries);
    end if;
    if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 8 then
      raise exception 'v% initial eight active providers failed', v_version;
    end if;
    -- A brand-new ninth identity is rejected too; check the whole request stays atomic.
    v_rejected := false;
    begin
      if v_version = 2 then
        perform public.upsert_quota_snapshots_v2(2, v_epoch, pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('generation', 0, 'envelope', v_replacement)));
      else
        -- The replacement has a tombstone from the preceding clear, with its current generation.
        select (item ->> 'generation')::bigint into v_generation
          from pg_catalog.jsonb_array_elements(v_read -> 'providerStates') item
          where item ->> 'providerId' = v_replacement ->> 'providerId';
        v_newer := pg_catalog.jsonb_set(pg_catalog.jsonb_set(v_replacement,
          '{windows,0,observedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
          '{windows,0,fetchedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '2 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
        perform public.upsert_quota_snapshots_v3(3, v_epoch, pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_newer)));
      end if;
    exception when sqlstate '22023' then
      if sqlerrm <> 'quota_snapshot_capacity_exceeded' then raise; end if;
      v_rejected := true;
    end;
    if not v_rejected then raise exception 'v% accepted ninth identity at full active capacity', v_version; end if;
    select (item ->> 'generation')::bigint into v_generation
      from pg_catalog.jsonb_array_elements(v_read -> 'providerStates') item
      where item ->> 'providerId' = v_first ->> 'providerId';
    v_read := public.delete_quota_snapshot_provider_v2(2, v_epoch,
      v_first ->> 'providerId', v_first ->> 'scope', v_generation);
    v_generation := v_generation + 1;
    -- Old generation and current generation with a pre-delete observation are both ignored.
    if v_version = 2 then
      v_read := public.upsert_quota_snapshots_v2(2, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', v_generation - 1, 'envelope', v_first)));
      v_read := public.upsert_quota_snapshots_v2(2, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_first)));
    else
      v_read := public.upsert_quota_snapshots_v3(3, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', v_generation - 1, 'envelope', v_first)));
      v_read := public.upsert_quota_snapshots_v3(3, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_first)));
    end if;
    if (v_read ->> 'ignoredProviderCount')::integer <> 1 or pg_catalog.jsonb_array_length(v_read -> 'providers') <> 7 then
      raise exception 'v% old observation resurrected a tombstone', v_version;
    end if;
    -- Replacement is a fresh identity in v2 and a cleared tombstone in v3.
    select coalesce((item ->> 'generation')::bigint,0) into v_generation
      from pg_catalog.jsonb_array_elements(v_read -> 'providerStates') item
      where item ->> 'providerId' = v_replacement ->> 'providerId';
    v_generation := coalesce(v_generation,0);
    v_newer := pg_catalog.jsonb_set(pg_catalog.jsonb_set(v_replacement,
      '{windows,0,observedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
      '{windows,0,fetchedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '2 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
    if v_version = 2 then
      v_read := public.upsert_quota_snapshots_v2(2, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_newer)));
    else
      v_read := public.upsert_quota_snapshots_v3(3, v_epoch, pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_newer)));
    end if;
    if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 8 or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 9 then
      raise exception 'v% delete-one/add-one must yield eight active plus one tombstone', v_version;
    end if;
    v_before := v_read - 'upsertedProviderCount' - 'ignoredProviderCount' - 'generatedAt';
    select (item ->> 'generation')::bigint into v_generation
      from pg_catalog.jsonb_array_elements(v_read -> 'providerStates') item
      where item ->> 'providerId' = v_first ->> 'providerId';
    v_newer := pg_catalog.jsonb_set(pg_catalog.jsonb_set(v_first,
      '{windows,0,observedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
      '{windows,0,fetchedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '2 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
    -- A new observation with the current tombstone generation still cannot become active #9.
    v_rejected := false;
    begin
      if v_version = 2 then
        perform public.upsert_quota_snapshots_v2(2, v_epoch, pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_newer)));
      else
        perform public.upsert_quota_snapshots_v3(3, v_epoch, pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_newer)));
      end if;
    exception when sqlstate '22023' then
      if sqlerrm <> 'quota_snapshot_capacity_exceeded' then raise; end if;
      v_rejected := true;
    end;
    if not v_rejected then raise exception 'v% tombstone resurrection exceeded eight active providers', v_version; end if;
    v_read := case when v_version = 2 then public.get_quota_snapshots_v2() else public.get_quota_snapshots_v3() end;
    if (v_read - 'generatedAt') <> v_before then raise exception 'v% rejected resurrection mutated snapshot', v_version; end if;
    -- A valid update before the overflowing resurrection must also roll back as one RPC.
    v_active := v_fixture #> '{sqlInitialProviders,1}';
    select (item ->> 'generation')::bigint into v_active_generation
      from pg_catalog.jsonb_array_elements(v_read -> 'providerStates') item
      where item ->> 'providerId' = v_active ->> 'providerId';
    v_active := pg_catalog.jsonb_set(pg_catalog.jsonb_set(pg_catalog.jsonb_set(v_active,
      '{displayName}', '"不应提交的匿名更新"'::jsonb),
      '{windows,0,observedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
      '{windows,0,fetchedAt}', pg_catalog.to_jsonb(pg_catalog.to_char((pg_catalog.clock_timestamp() + interval '2 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
    v_rejected := false;
    begin
      if v_version = 2 then
        perform public.upsert_quota_snapshots_v2(2, v_epoch, pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('generation', v_active_generation, 'envelope', v_active),
          pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_newer)));
      else
        perform public.upsert_quota_snapshots_v3(3, v_epoch, pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('generation', v_active_generation, 'envelope', v_active),
          pg_catalog.jsonb_build_object('generation', v_generation, 'envelope', v_newer)));
      end if;
    exception when sqlstate '22023' then
      if sqlerrm <> 'quota_snapshot_capacity_exceeded' then raise; end if;
      v_rejected := true;
    end;
    if not v_rejected then raise exception 'v% mixed overflowing RPC did not reject', v_version; end if;
    v_read := case when v_version = 2 then public.get_quota_snapshots_v2() else public.get_quota_snapshots_v3() end;
    if (v_read - 'generatedAt') <> v_before then raise exception 'v% overflow leaked a partial update', v_version; end if;
    v_read := public.clear_quota_snapshots_v2(2, v_epoch);
    if pg_catalog.jsonb_array_length(v_read -> 'providers') <> 0 or pg_catalog.jsonb_array_length(v_read -> 'providerStates') <> 9 then
      raise exception 'v% clear must keep all nine tombstones', v_version;
    end if;
    v_rejected := false;
    begin
      if v_version = 2 then perform public.upsert_quota_snapshots_v2(2, v_epoch, v_entries);
      else perform public.upsert_quota_snapshots_v3(3, v_epoch, v_entries); end if;
    exception when sqlstate '22023' then
      if sqlerrm <> 'quota_snapshot_stale_epoch' then raise; end if;
      v_rejected := true;
    end;
    if not v_rejected then raise exception 'v% clear failed to block old epoch', v_version; end if;
  end loop;
end;
$$;
rollback;
