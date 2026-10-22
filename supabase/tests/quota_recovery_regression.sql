\set ON_ERROR_STOP on
begin;
create temporary table quota_recovery_fixture(payload jsonb not null) on commit drop;
insert into quota_recovery_fixture values (:'capacity_fixture'::jsonb);
grant select on quota_recovery_fixture to authenticated;
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('88888888-8888-4888-8888-888888888888', 'quota-recovery@example.invalid', '{}', '{}', now(), now()),
       ('99999999-9999-4999-8999-999999999999', 'quota-other@example.invalid', '{}', '{}', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  v_envelope jsonb := (select payload #> '{sqlInitialProviders,0}' from quota_recovery_fixture);
  v_version integer;
  v_epoch bigint;
  v_before jsonb;
  v_after jsonb;
  v_meta jsonb;
  v_generation bigint;
  v_entry jsonb;
  v_future jsonb;
  v_now timestamptz;
  v_rejected boolean;
  v_case integer;
begin
  foreach v_version in array array[2,3] loop
    v_meta := public.get_quota_snapshot_clear_metadata_v2();
    if (select count(*) from jsonb_object_keys(v_meta)) <> 5
       or v_meta ->> 'status' <> 'ok' or (v_meta ->> 'transportVersion')::integer <> 2
       or octet_length(v_meta::text) > 1024 then
      raise exception 'recovery metadata shape or budget failed';
    end if;
    v_epoch := (v_meta ->> 'epoch')::bigint;
    v_before := case when v_version = 2 then public.get_quota_snapshots_v2() else public.get_quota_snapshots_v3() end;
    select coalesce((s ->> 'generation')::bigint, 0) into v_generation
      from jsonb_array_elements(v_before -> 'providerStates') s
      where s ->> 'providerId' = v_envelope ->> 'providerId';
    v_generation := coalesce(v_generation, 0);
    v_now := clock_timestamp();
    -- A future reset is legitimate; only the observation conflict clock is bounded.
    v_envelope := jsonb_set(jsonb_set(jsonb_set(v_envelope,
      '{windows,0,observedAt}', to_jsonb(v_now + interval '1 second')),
      '{windows,0,fetchedAt}', to_jsonb(v_now + interval '2 seconds')),
      '{windows,0,resetsAt}', to_jsonb(v_now + interval '30 days'));
    v_entry := jsonb_build_object('generation', v_generation, 'envelope', v_envelope);
    v_after := case when v_version = 2 then public.upsert_quota_snapshots_v2(2,v_epoch,jsonb_build_array(v_entry))
      else public.upsert_quota_snapshots_v3(3,v_epoch,jsonb_build_array(v_entry)) end;
    if v_after #>> '{providers,0,windows,0,observedAt}' <> v_envelope #>> '{windows,0,observedAt}' then
      raise exception 'valid observation was rewritten';
    end if;
    v_before := v_after - 'upsertedProviderCount' - 'ignoredProviderCount' - 'generatedAt';
    v_entry := jsonb_set(v_entry, '{envelope,displayName}', '"must-rollback"');
    v_future := jsonb_set(jsonb_set(v_entry, '{envelope,providerId}', '"company-openapi-future"'),
      '{envelope,windows,0,providerId}', '"company-openapi-future"');
    v_future := jsonb_set(jsonb_set(v_future,'{generation}','0'), '{envelope,windows,0,observedAt}', to_jsonb(v_now + interval '6 minutes'));
    v_rejected := false;
    begin
      -- The normal first entry must roll back when the second entry is invalid.
      if v_version = 2 then perform public.upsert_quota_snapshots_v2(2,v_epoch,jsonb_build_array(v_entry,v_future));
      else perform public.upsert_quota_snapshots_v3(3,v_epoch,jsonb_build_array(v_entry,v_future)); end if;
    exception when sqlstate '22023' then
      if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
      v_rejected := true;
    end;
    if not v_rejected then raise exception 'far-future observation accepted'; end if;
    v_after := case when v_version = 2 then public.get_quota_snapshots_v2() else public.get_quota_snapshots_v3() end;
    if (v_after - 'generatedAt') <> v_before then raise exception 'future rejection partially mutated snapshot'; end if;
    -- Existing active updates and current-generation tombstone resurrection obey the same rule.
    for v_case in 1..2 loop
      if v_case = 2 then
        perform public.delete_quota_snapshot_provider_v2(2,v_epoch,
          v_envelope ->> 'providerId',v_envelope ->> 'scope',v_generation);
        v_generation := v_generation + 1;
      end if;
      v_future := jsonb_set(jsonb_set(v_entry,'{generation}',to_jsonb(v_generation)),
        '{envelope,windows,0,observedAt}',to_jsonb(clock_timestamp() + interval '6 minutes'));
      v_rejected := false;
      begin
        if v_version = 2 then perform public.upsert_quota_snapshots_v2(2,v_epoch,jsonb_build_array(v_future));
        else perform public.upsert_quota_snapshots_v3(3,v_epoch,jsonb_build_array(v_future)); end if;
      exception when sqlstate '22023' then
        if sqlerrm <> 'quota_snapshot_invalid_payload' then raise; end if;
        v_rejected := true;
      end;
      if not v_rejected then raise exception 'future active/resurrection accepted'; end if;
    end loop;
    -- A stale generation is still ignored before the future-clock check.
    v_future := jsonb_set(v_future,'{generation}',to_jsonb(v_generation - 1));
    v_after := case when v_version = 2 then public.upsert_quota_snapshots_v2(2,v_epoch,jsonb_build_array(v_future))
      else public.upsert_quota_snapshots_v3(3,v_epoch,jsonb_build_array(v_future)) end;
    if (v_after ->> 'ignoredProviderCount')::integer <> 1 then raise exception 'stale generation priority changed'; end if;
    v_entry := jsonb_set(v_entry,'{generation}',to_jsonb(v_generation));
    -- Near-boundary real-clock acceptance; strict equality is covered by the SQL > predicate.
    v_entry := jsonb_set(v_entry, '{envelope,windows,0,observedAt}', to_jsonb(clock_timestamp() + interval '5 minutes'));
    if v_version = 2 then perform public.upsert_quota_snapshots_v2(2,v_epoch,jsonb_build_array(v_entry));
    else perform public.upsert_quota_snapshots_v3(3,v_epoch,jsonb_build_array(v_entry)); end if;
    v_meta := public.get_quota_snapshot_clear_metadata_v2();
    v_after := public.clear_quota_snapshots_v2(2, (v_meta ->> 'epoch')::bigint);
    if (v_after ->> 'epoch')::bigint <= (v_meta ->> 'epoch')::bigint
       or (v_after ->> 'revision')::bigint <= (v_meta ->> 'revision')::bigint
       or jsonb_array_length(v_after -> 'providers') <> 0 then raise exception 'metadata clear failed'; end if;
    begin
      perform public.clear_quota_snapshots_v2(2, (v_meta ->> 'epoch')::bigint);
      raise exception 'stale clear accepted';
    exception when sqlstate '22023' then
      if sqlerrm <> 'quota_snapshot_stale_epoch' then raise; end if;
    end;
  end loop;
end;
$$;
reset role;
-- Seed a historical malformed row as database owner, never through a client write path.
update private.quota_snapshots set envelope = '{"corruptHistoricalEnvelope":true}', deleted_at = null, source_observed_at = clock_timestamp()
where user_id = '88888888-8888-4888-8888-888888888888';
set local role authenticated;
do $$
declare m jsonb; r jsonb;
begin
  m := public.get_quota_snapshot_clear_metadata_v2();
  r := public.clear_quota_snapshots_v2(2,(m ->> 'epoch')::bigint);
  if jsonb_array_length(r -> 'providers') <> 0 or (r ->> 'clearedProviderCount')::integer <> 1 then
    raise exception 'historical malformed envelope prevented recovery';
  end if;
  perform set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
  m := public.get_quota_snapshot_clear_metadata_v2();
  if (m ->> 'epoch')::bigint <> 1 or (m ->> 'revision')::bigint <> 0 then
    raise exception 'metadata leaked another owner timeline';
  end if;
end;
$$;
reset role;
do $$
begin
  if has_function_privilege('anon','public.get_quota_snapshot_clear_metadata_v2()','execute')
     or has_function_privilege('service_role','public.get_quota_snapshot_clear_metadata_v2()','execute')
     or not has_function_privilege('authenticated','public.get_quota_snapshot_clear_metadata_v2()','execute') then
    raise exception 'metadata RPC grants invalid';
  end if;
  if exists (select 1 from pg_proc where oid = 'public.get_quota_snapshot_clear_metadata_v2()'::regprocedure
    and not ('search_path=""' = any(proconfig))) then raise exception 'metadata search_path unsafe'; end if;
end;
$$;
rollback;
