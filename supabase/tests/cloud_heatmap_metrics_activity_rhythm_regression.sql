\set ON_ERROR_STOP on

-- dashboard-stats-v2 §2.6 cloud heatmapRequests/heatmapCost and
-- activity-rhythm-cloud-v1: owner-scoped hourly rhythm aggregates.
begin;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('5a5a0000-0000-4000-8000-000000000001', 'rhythm-one@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('5a5a0000-0000-4000-8000-000000000002', 'rhythm-two@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- D1 = today - 2 and D2 = today - 1 in UTC, so the custom range is always valid.
do $fixture$
declare
  d1 text := ((pg_catalog.now() at time zone 'UTC')::date - 2)::text;
  d2 text := ((pg_catalog.now() at time zone 'UTC')::date - 1)::text;
  u1 uuid := '5a5a0000-0000-4000-8000-000000000001';
  u2 uuid := '5a5a0000-0000-4000-8000-000000000002';
begin
  insert into public.token_logs (
    user_id, tool, model, input_tokens, output_tokens, cached_tokens,
    cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, requests
  ) values
    (u1, 'RhythmA', 'RhythmX', 100, 20, 5, 1, d1 || ' 10:00:00', 'agg', 'r1', 0.10, 'rhythm-mac', 2),
    (u1, 'RhythmA', 'RhythmX', 50, 10, 0, 0, d1 || ' 14:00:00', 'agg', 'r2', 0.05, 'rhythm-mac', 1),
    (u1, 'RhythmB', 'RhythmY', 200, 30, 0, 0, d1 || ' 10:00:00', 'agg', 'r3', null, 'rhythm-pc', 3),
    (u1, 'RhythmA', 'RhythmX', 10, 5, 0, 0, d2 || ' 09:00:00', 'agg', 'r4', 0.0000004, 'rhythm-mac', 1),
    (u1, 'RhythmC', 'RhythmZ', 1, 1, 0, 0, d1 || ' 12:00:00', 'agg', 'r5', 0, 'rhythm-mac', 1),
    (u1, 'RhythmD', 'RhythmW', 2, 2, 0, 0, d1 || ' 12:00:00', 'agg', 'r6', 0.01, 'rhythm-mac', 0),
    (u2, 'RhythmA', 'RhythmX', 9000, 999, 0, 0, d1 || ' 10:00:00', 'agg', 'other', 1.0, 'rhythm-mac', 9);
end;
$fixture$;

do $schema$
begin
  if pg_catalog.to_regprocedure('public.get_activity_rhythm_v1(jsonb)') is null then
    raise exception 'get_activity_rhythm_v1 is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = 'public.get_activity_rhythm_v1(jsonb)'::pg_catalog.regprocedure
      and p.prosecdef
      and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'get_activity_rhythm_v1 must be SECURITY DEFINER with empty search_path';
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.get_activity_rhythm_v1(jsonb)', 'execute')
     or pg_catalog.has_function_privilege('anon', 'public.get_activity_rhythm_v1(jsonb)', 'execute')
     or pg_catalog.has_function_privilege('public', 'public.get_activity_rhythm_v1(jsonb)', 'execute') then
    raise exception 'get_activity_rhythm_v1 grants are wrong';
  end if;
  if pg_catalog.has_function_privilege('authenticated', 'private.tokenledger_heatmap_metrics_v1(uuid,jsonb,jsonb)', 'execute')
     or pg_catalog.has_function_privilege('anon', 'private.tokenledger_heatmap_metrics_v1(uuid,jsonb,jsonb)', 'execute') then
    raise exception 'heatmap metrics helper must not be client-callable';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = 'public.get_dashboard_stats_v2(uuid,jsonb)'::pg_catalog.regprocedure
      and p.prosecdef
      and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'dashboard lost SECURITY DEFINER or empty search_path';
  end if;
end;
$schema$;

-- Anonymous callers are refused at the grant boundary.
set local role anon;
do $anon$
begin
  begin
    perform public.get_activity_rhythm_v1('{"range":"today","timezone":"UTC"}'::jsonb);
    raise exception 'anonymous rhythm read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$anon$;
reset role;

-- Authenticated role without a subject is refused by the owner check.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '', true);
do $nosub$
begin
  begin
    perform public.get_activity_rhythm_v1('{"range":"today","timezone":"UTC"}'::jsonb);
    raise exception 'rhythm read without subject unexpectedly succeeded';
  exception when sqlstate '42501' then null;
  end;
end;
$nosub$;

select pg_catalog.set_config('request.jwt.claim.sub', '5a5a0000-0000-4000-8000-000000000001', true);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $checks$
declare
  d1 text := ((pg_catalog.now() at time zone 'UTC')::date - 2)::text;
  d2 text := ((pg_catalog.now() at time zone 'UTC')::date - 1)::text;
  u1 uuid := '5a5a0000-0000-4000-8000-000000000001';
  q jsonb;
  r jsonb;
  dash jsonb;
  v_path text[];
  v_obj jsonb;
  v_heat_keys text[];
  v_other_keys text[];
  v_bad text;
begin
  q := pg_catalog.jsonb_build_object(
    'range', 'custom', 'start', d1, 'end', d2, 'timezone', 'UTC',
    'machines', '[]'::jsonb, 'tools', '[]'::jsonb, 'models', '[]'::jsonb,
    'search', null, 'tokenMode', 'effective'
  );

  -- Dashboard heatmap metrics -------------------------------------------------
  dash := public.get_dashboard_stats_v2(u1, q);
  if (dash #>> array['heatmap', d1])::bigint is distinct from 416
     or (dash #>> array['heatmap', d2])::bigint is distinct from 15 then
    raise exception 'fixture heatmap changed: %', dash -> 'heatmap';
  end if;
  if dash -> 'heatmapRequests' is distinct from pg_catalog.jsonb_build_object(d1, 7, d2, 1) then
    raise exception 'top heatmapRequests wrong: %', dash -> 'heatmapRequests';
  end if;
  if dash ? 'heatmapCost' then
    raise exception 'top heatmapCost must be omitted when a contributing row has null cost: %', dash -> 'heatmapCost';
  end if;

  if dash #> '{tools,RhythmA,heatmapRequests}' is distinct from pg_catalog.jsonb_build_object(d1, 3, d2, 1)
     or (dash #>> array['tools', 'RhythmA', 'heatmapCost', d1])::numeric is distinct from 0.15
     or (dash #>> array['tools', 'RhythmA', 'heatmapCost', d2])::numeric is distinct from 0 then
    raise exception 'RhythmA heatmap metrics wrong: %', dash #> '{tools,RhythmA}';
  end if;
  if dash #> '{tools,RhythmB,heatmapRequests}' is distinct from pg_catalog.jsonb_build_object(d1, 3)
     or dash #> '{tools,RhythmB}' ? 'heatmapCost' then
    raise exception 'RhythmB must keep counts and omit unknown cost: %', dash #> '{tools,RhythmB}';
  end if;
  if dash #> '{tools,RhythmC,heatmapRequests}' is distinct from pg_catalog.jsonb_build_object(d1, 1)
     or dash #> '{tools,RhythmC}' ? 'heatmapCost' then
    raise exception 'RhythmC legacy zero cost must omit heatmapCost: %', dash #> '{tools,RhythmC}';
  end if;
  if dash #> '{tools,RhythmD}' ? 'heatmapRequests'
     or (dash #>> array['tools', 'RhythmD', 'heatmapCost', d1])::numeric is distinct from 0.01 then
    raise exception 'RhythmD zero-request day must omit heatmapRequests only: %', dash #> '{tools,RhythmD}';
  end if;
  if dash #> '{models,RhythmX,heatmapRequests}' is distinct from pg_catalog.jsonb_build_object(d1, 3, d2, 1)
     or (dash #>> array['models', 'RhythmX', 'heatmapCost', d1])::numeric is distinct from 0.15
     or dash #> '{models,RhythmY}' ? 'heatmapCost'
     or dash #> '{models,RhythmY,heatmapRequests}' is distinct from pg_catalog.jsonb_build_object(d1, 3) then
    raise exception 'model heatmap metrics wrong: %', dash -> 'models';
  end if;
  -- Existing fields are untouched.
  if (dash #>> '{summary,totalTokens}')::bigint is distinct from 431
     or pg_catalog.jsonb_typeof(dash -> 'dailyCosts') is distinct from 'object' then
    raise exception 'dashboard existing fields changed: %', dash -> 'summary';
  end if;

  -- Filters apply to the extra fields as well.
  dash := public.get_dashboard_stats_v2(u1, q || '{"tools":["RhythmA"]}'::jsonb);
  if dash -> 'heatmapRequests' is distinct from pg_catalog.jsonb_build_object(d1, 3, d2, 1)
     or (dash #>> array['heatmapCost', d1])::numeric is distinct from 0.15 then
    raise exception 'tool filter not applied to top heatmap metrics: %', dash;
  end if;

  -- Key invariant on every range: same date keys as heatmap, positive counts,
  -- non-negative finite costs.
  foreach v_bad in array array['today', 'week', 'month', 'year', 'all', 'custom'] loop
    dash := public.get_dashboard_stats_v2(
      u1,
      case when v_bad = 'custom' then q
        else pg_catalog.jsonb_build_object('range', v_bad, 'timezone', 'UTC') end
    );
    for v_path in
      select array[]::text[]
      union all select array['tools', k] from pg_catalog.jsonb_object_keys(dash -> 'tools') k
      union all select array['models', k] from pg_catalog.jsonb_object_keys(dash -> 'models') k
    loop
      v_obj := case when pg_catalog.cardinality(v_path) = 0 then dash else dash #> v_path end;
      select coalesce(pg_catalog.array_agg(k order by k), array[]::text[])
        into v_heat_keys from pg_catalog.jsonb_object_keys(v_obj -> 'heatmap') k;
      if v_obj ? 'heatmapRequests' then
        select coalesce(pg_catalog.array_agg(k order by k), array[]::text[])
          into v_other_keys from pg_catalog.jsonb_object_keys(v_obj -> 'heatmapRequests') k;
        if v_other_keys is distinct from v_heat_keys or exists (
          select 1 from pg_catalog.jsonb_each(v_obj -> 'heatmapRequests') e
          where pg_catalog.jsonb_typeof(e.value) <> 'number' or (e.value::text)::numeric < 1
            or (e.value::text)::numeric <> pg_catalog.trunc((e.value::text)::numeric)
        ) then
          raise exception '% %: heatmapRequests keys/values invalid: %', v_bad, v_path, v_obj;
        end if;
      end if;
      if v_obj ? 'heatmapCost' then
        select coalesce(pg_catalog.array_agg(k order by k), array[]::text[])
          into v_other_keys from pg_catalog.jsonb_object_keys(v_obj -> 'heatmapCost') k;
        if v_other_keys is distinct from v_heat_keys or exists (
          select 1 from pg_catalog.jsonb_each(v_obj -> 'heatmapCost') e
          where pg_catalog.jsonb_typeof(e.value) <> 'number' or (e.value::text)::numeric < 0
        ) then
          raise exception '% %: heatmapCost keys/values invalid: %', v_bad, v_path, v_obj;
        end if;
      end if;
    end loop;
  end loop;

  -- Activity rhythm -----------------------------------------------------------
  r := public.get_activity_rhythm_v1(q);
  if r #>> '{meta,source}' <> 'cloud'
     or r #>> '{meta,start}' <> d1
     or r #>> '{meta,end}' <> d2
     or r #>> '{meta,timezone}' <> 'UTC'
     or r #>> '{meta,range}' <> 'custom'
     or (r #>> '{meta,recordCount}')::numeric <> 8
     or r #>> '{meta,firstRecordAt}' <> d1 || ' 10:00:00'
     or r #>> '{meta,lastRecordAt}' <> d2 || ' 09:00:00'
     or (r #>> '{meta,rangeTruncated}')::boolean then
    raise exception 'rhythm meta wrong: %', r -> 'meta';
  end if;
  if r -> 'summary' <> '{"tokens":431,"inputTokens":363,"outputTokens":68,"cachedTokens":5,"requests":8,"activeDays":2,"toolCount":4,"modelCount":4}'::jsonb then
    raise exception 'rhythm summary wrong (other user leaked or cache folded in?): %', r -> 'summary';
  end if;
  if r -> 'tools' <> '[{"id":"RhythmB","tokens":230,"requests":3},{"id":"RhythmA","tokens":195,"requests":4},{"id":"RhythmD","tokens":4,"requests":0},{"id":"RhythmC","tokens":2,"requests":1}]'::jsonb then
    raise exception 'rhythm tools wrong: %', r -> 'tools';
  end if;
  if r -> 'dayHours' <> pg_catalog.jsonb_build_array(
       pg_catalog.jsonb_build_object('date', d1, 'hour', 10, 'tokens', 350, 'requests', 5),
       pg_catalog.jsonb_build_object('date', d1, 'hour', 12, 'tokens', 6, 'requests', 1),
       pg_catalog.jsonb_build_object('date', d1, 'hour', 14, 'tokens', 60, 'requests', 1),
       pg_catalog.jsonb_build_object('date', d2, 'hour', 9, 'tokens', 15, 'requests', 1)
     ) then
    raise exception 'rhythm dayHours wrong: %', r -> 'dayHours';
  end if;
  if r -> 'modelHours' <> '[{"hour":9,"model":"RhythmX","tokens":15,"requests":1},{"hour":10,"model":"RhythmX","tokens":120,"requests":2},{"hour":10,"model":"RhythmY","tokens":230,"requests":3},{"hour":12,"model":"RhythmW","tokens":4,"requests":0},{"hour":12,"model":"RhythmZ","tokens":2,"requests":1},{"hour":14,"model":"RhythmX","tokens":60,"requests":1}]'::jsonb then
    raise exception 'rhythm modelHours wrong: %', r -> 'modelHours';
  end if;
  if r -> 'modelDays' <> pg_catalog.jsonb_build_array(
       pg_catalog.jsonb_build_object('date', d1, 'model', 'RhythmW', 'tokens', 4, 'requests', 0),
       pg_catalog.jsonb_build_object('date', d1, 'model', 'RhythmX', 'tokens', 180, 'requests', 3),
       pg_catalog.jsonb_build_object('date', d1, 'model', 'RhythmY', 'tokens', 230, 'requests', 3),
       pg_catalog.jsonb_build_object('date', d1, 'model', 'RhythmZ', 'tokens', 2, 'requests', 1),
       pg_catalog.jsonb_build_object('date', d2, 'model', 'RhythmX', 'tokens', 15, 'requests', 1)
     ) then
    raise exception 'rhythm modelDays wrong: %', r -> 'modelDays';
  end if;
  if r ? 'sessions' or r ? 'requestSizes' then
    raise exception 'rhythm must not claim sessions or request sizes';
  end if;

  -- Canonical filters.
  r := public.get_activity_rhythm_v1(q || '{"tools":["RhythmB"]}'::jsonb);
  if (r #>> '{summary,tokens}')::bigint <> 230 or pg_catalog.jsonb_array_length(r -> 'dayHours') <> 1 then
    raise exception 'rhythm tool filter wrong: %', r;
  end if;
  r := public.get_activity_rhythm_v1(q || '{"machines":["rhythm-pc"]}'::jsonb);
  if (r #>> '{summary,tokens}')::bigint <> 230 then
    raise exception 'rhythm machine filter wrong: %', r -> 'summary';
  end if;
  r := public.get_activity_rhythm_v1(q || '{"search":"rhythmz"}'::jsonb);
  if (r #>> '{summary,tokens}')::bigint <> 2 then
    raise exception 'rhythm search filter wrong: %', r -> 'summary';
  end if;
  r := public.get_activity_rhythm_v1(
    pg_catalog.jsonb_build_object('range', 'custom', 'start', d2, 'end', d2, 'timezone', 'UTC')
  );
  if (r #>> '{summary,tokens}')::bigint <> 15 or (r #>> '{summary,activeDays}')::int <> 1 then
    raise exception 'rhythm single-day custom range wrong: %', r -> 'summary';
  end if;

  -- Empty result is an explicit zero, not an error.
  r := public.get_activity_rhythm_v1('{"range":"custom","start":"2020-01-01","end":"2020-01-02","timezone":"UTC"}'::jsonb);
  if (r #>> '{summary,tokens}')::bigint <> 0 or r -> 'dayHours' <> '[]'::jsonb
     or r -> 'tools' <> '[]'::jsonb or r #> '{meta,firstRecordAt}' <> 'null'::jsonb then
    raise exception 'empty rhythm result wrong: %', r;
  end if;

  -- 'all' covers the last 731 local days and reports the first record date.
  r := public.get_activity_rhythm_v1('{"range":"all","timezone":"UTC"}'::jsonb);
  if r #>> '{meta,start}' <> d1 or (r #>> '{meta,rangeDayLimit}')::int <> 731
     or (r #>> '{summary,tokens}')::bigint <> 431 then
    raise exception 'rhythm all range wrong: %', r -> 'meta';
  end if;

  -- Same validation as Stats v2.
  begin
    perform public.get_activity_rhythm_v1('{"range":"bogus"}'::jsonb);
    raise exception 'invalid range unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.get_activity_rhythm_v1('{"range":"custom","start":"2024-01-01","end":"2026-01-01","timezone":"UTC"}'::jsonb);
    raise exception 'range longer than 731 days unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.get_activity_rhythm_v1('[]'::jsonb);
    raise exception 'non-object query unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
end;
$checks$;

reset role;

-- 'all' reports truncation when matching rows predate the 731-day window.
insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, requests
) values (
  '5a5a0000-0000-4000-8000-000000000001', 'RhythmA', 'RhythmX', 1, 1, 0, 0,
  pg_catalog.to_char((pg_catalog.now() at time zone 'UTC')::date - 900, 'YYYY-MM-DD') || ' 08:00:00',
  'agg', 'old', 0.01, 'rhythm-mac', 1
);

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '5a5a0000-0000-4000-8000-000000000001', true);
do $truncated$
declare
  r jsonb := public.get_activity_rhythm_v1('{"range":"all","timezone":"UTC"}'::jsonb);
begin
  if not (r #>> '{meta,rangeTruncated}')::boolean
     or r #>> '{meta,start}' <> ((pg_catalog.now() at time zone 'UTC')::date - 730)::text
     or (r #>> '{summary,tokens}')::bigint <> 431 then
    raise exception 'rhythm all truncation wrong: %', r -> 'meta';
  end if;
end;
$truncated$;
reset role;

rollback;
