-- T10.113: custom local-date ranges for every Stats v2 surface.
-- token_logs.timestamp is an ISO wall-clock text column. Bounds therefore stay
-- timestamp-without-time-zone until response metadata explicitly attaches the
-- requested IANA zone. This preserves local calendar days across DST changes.

alter function private.tokenledger_normalize_query_v2(jsonb)
  rename to tokenledger_normalize_query_v2_pre_custom;

create or replace function private.tokenledger_normalize_query_v2(p_query jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_input jsonb := coalesce(p_query, '{}'::jsonb);
  v_range text;
  v_start_text text;
  v_end_text text;
  v_start date;
  v_end date;
  v_result jsonb;
begin
  if pg_catalog.jsonb_typeof(v_input) <> 'object' then
    raise exception 'query-v2: p_query must be an object' using errcode = '22023';
  end if;
  if v_input ? 'range' and pg_catalog.jsonb_typeof(v_input -> 'range') <> 'string' then
    raise exception 'query-v2: range must be a string' using errcode = '22023';
  end if;
  v_range := pg_catalog.lower(private.tokenledger_ascii_trim_v2(coalesce(v_input ->> 'range', 'today')));

  if v_range <> 'custom' then
    return private.tokenledger_normalize_query_v2_pre_custom(v_input - 'start' - 'end');
  end if;

  if pg_catalog.jsonb_typeof(v_input -> 'start') is distinct from 'string'
     or pg_catalog.jsonb_typeof(v_input -> 'end') is distinct from 'string' then
    raise exception 'query-v2: custom range requires string start/end' using errcode = '22023';
  end if;
  v_start_text := v_input ->> 'start';
  v_end_text := v_input ->> 'end';
  if v_start_text !~ '^\d{4}-\d{2}-\d{2}$' or v_end_text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'query-v2: custom start/end must use YYYY-MM-DD' using errcode = '22023';
  end if;
  begin
    v_start := v_start_text::date;
    v_end := v_end_text::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'query-v2: invalid custom calendar date' using errcode = '22023';
  end;
  if v_start > v_end then
    raise exception 'query-v2: custom start must be on or before end' using errcode = '22023';
  end if;
  if v_start > (pg_catalog.now() at time zone coalesce(nullif(v_input ->> 'timezone', ''), 'UTC'))::date then
    raise exception 'query-v2: custom start must not be after today' using errcode = '22023';
  end if;
  if (v_end - v_start + 1) > 731 then
    raise exception 'query-v2: custom range exceeds 731 days' using errcode = '22023';
  end if;

  v_result := private.tokenledger_normalize_query_v2_pre_custom(
    (v_input - 'start' - 'end') || '{"range":"today"}'::jsonb
  );
  return (v_result - 'range') || pg_catalog.jsonb_build_object(
    'range', 'custom', 'start', v_start::text, 'end', v_end::text
  );
end;
$$;

create or replace function private.tokenledger_custom_bounds_v2(p_query jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_timezone text := p_query ->> 'timezone';
  v_now timestamp := pg_catalog.now() at time zone (p_query ->> 'timezone');
  v_start timestamp := (p_query ->> 'start')::date::timestamp;
  v_requested_end timestamp := ((p_query ->> 'end')::date + 1)::timestamp - interval '1 second';
  v_end timestamp;
  v_span_days integer := (p_query ->> 'end')::date - (p_query ->> 'start')::date + 1;
  v_previous_start timestamp;
  v_previous_end timestamp;
begin
  v_end := least(v_requested_end, v_now);
  v_previous_start := v_start - pg_catalog.make_interval(days => v_span_days);
  v_previous_end := v_previous_start + (v_end - v_start);
  return pg_catalog.jsonb_build_object(
    'currentStart', v_start,
    'currentEnd', v_end,
    'previousStart', v_previous_start,
    'previousEnd', v_previous_end,
    'bucket', case when v_span_days = 1 then 'hour' else 'day' end,
    'spanDays', v_span_days,
    'timezone', v_timezone
  );
end;
$$;

-- Patch the frozen base and the three core implementations at their small,
-- range-specific seams. Every replacement is shape-checked and aborts the
-- migration if an earlier migration changed the expected definition.
do $migration$
declare
  v_sig regprocedure;
  v_definition text;
  v_needle text;
  v_replacement text;
begin
  v_sig := coalesce(
    pg_catalog.to_regprocedure('private.get_dashboard_stats_v2_base_v5(uuid,jsonb)'),
    pg_catalog.to_regprocedure('private.get_dashboard_stats_v2_base_t63(uuid,jsonb)')
  );
  if v_sig is null then raise exception 'T10.113 dashboard base function is missing'; end if;
  select pg_catalog.pg_get_functiondef(v_sig) into v_definition;
  v_definition := pg_catalog.replace(v_definition, E'\r\n', E'\n');
  v_needle := $needle$  case v_range
    when 'today' then
      v_start := pg_catalog.date_trunc('day', v_now);
      v_trend_bucket := 'hour';
    when 'week' then
      v_start := pg_catalog.date_trunc('week', v_now);
      v_trend_bucket := 'day';
    when 'month' then
      v_start := pg_catalog.date_trunc('month', v_now);
      v_trend_bucket := 'day';
    when 'year' then
      v_start := pg_catalog.date_trunc('year', v_now);
      v_trend_bucket := 'month';
    when 'all' then
      v_start := null;
      v_trend_bucket := 'day';
  end case;
  v_start_text := case when v_start is null then null
    else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;
  v_end_text := pg_catalog.to_char(v_now, 'YYYY-MM-DD HH24:MI:SS');$needle$;
  v_replacement := $replacement$  if v_range = 'custom' then
    v_start_text := (v_query ->> 'start') || ' 00:00:00';
    v_end_text := pg_catalog.to_char(
      least(((v_query ->> 'end')::date + 1)::timestamp - interval '1 second', v_now),
      'YYYY-MM-DD HH24:MI:SS'
    );
    v_trend_bucket := case when v_query ->> 'start' = v_query ->> 'end' then 'hour' else 'day' end;
  else
    case v_range
      when 'today' then v_start := pg_catalog.date_trunc('day', v_now); v_trend_bucket := 'hour';
      when 'week' then v_start := pg_catalog.date_trunc('week', v_now); v_trend_bucket := 'day';
      when 'month' then v_start := pg_catalog.date_trunc('month', v_now); v_trend_bucket := 'day';
      when 'year' then v_start := pg_catalog.date_trunc('year', v_now); v_trend_bucket := 'month';
      when 'all' then v_start := null; v_trend_bucket := 'day';
    end case;
    v_start_text := case when v_start is null then null else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;
    v_end_text := pg_catalog.to_char(v_now, 'YYYY-MM-DD HH24:MI:SS');
  end if;$replacement$;
  if pg_catalog.strpos(v_definition, v_needle) = 0 then raise exception 'T10.113 base range seam changed'; end if;
  execute pg_catalog.replace(v_definition, v_needle, v_replacement);

  v_sig := 'private.tokenledger_usage_details_core_v2(uuid,jsonb,jsonb,text,integer)'::regprocedure;
  select pg_catalog.pg_get_functiondef(v_sig) into v_definition;
  v_definition := pg_catalog.replace(v_definition, E'\r\n', E'\n');
  v_needle := $needle$  v_end := v_now;
  case v_range
    when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
    when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
    when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
    when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
    when 'all' then v_start := null;
    else raise exception 'get_usage_details_v2: invalid canonical range %', v_range
      using errcode = '22023';
  end case;
  v_start_text := case when v_start is null then null
    else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;
  v_end_text := pg_catalog.to_char(v_end, 'YYYY-MM-DD HH24:MI:SS');$needle$;
  v_replacement := $replacement$  v_end := v_now;
  if v_range = 'custom' then
    v_start := (p_query ->> 'start')::date::timestamp;
    v_end := least(((p_query ->> 'end')::date + 1)::timestamp - interval '1 second', v_now);
  else
    case v_range
      when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
      when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
      when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
      when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
      when 'all' then v_start := null;
      else raise exception 'get_usage_details_v2: invalid canonical range %', v_range using errcode = '22023';
    end case;
  end if;
  v_start_text := case when v_start is null then null else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;
  v_end_text := pg_catalog.to_char(v_end, 'YYYY-MM-DD HH24:MI:SS');$replacement$;
  if pg_catalog.strpos(v_definition, v_needle) = 0 then raise exception 'T10.113 details range seam changed'; end if;
  execute pg_catalog.replace(v_definition, v_needle, v_replacement);

  v_sig := 'private.tokenledger_usage_comparison_core_v2(uuid,jsonb,jsonb)'::regprocedure;
  select pg_catalog.pg_get_functiondef(v_sig) into v_definition;
  v_definition := pg_catalog.replace(v_definition, E'\r\n', E'\n');
  v_needle := $needle$  if v_range not in ('today', 'week', 'month') then
    return null;
  end if;

  case v_range$needle$;
  v_replacement := $replacement$  if v_range not in ('today', 'week', 'month', 'custom') then
    return null;
  end if;

  if v_range = 'custom' then
    select
      (b ->> 'currentStart')::timestamp,
      (b ->> 'currentEnd')::timestamp,
      (b ->> 'previousStart')::timestamp,
      (b ->> 'previousEnd')::timestamp,
      b ->> 'bucket'
    into v_current_start, v_current_end, v_previous_start, v_previous_end, v_bucket
    from (select private.tokenledger_custom_bounds_v2(p_query) as b) bounds;
    v_kind := 'periodOverPeriod';
    v_aligned_through := case when v_bucket = 'hour'
      then pg_catalog.to_char(v_current_end, 'HH24:MI')
      else 'D' || (v_current_end::date - v_current_start::date + 1)::text
        || ' ' || pg_catalog.to_char(v_current_end, 'HH24:MI') end;
  else
  case v_range$replacement$;
  if pg_catalog.strpos(v_definition, v_needle) = 0 then raise exception 'T10.113 comparison prelude changed'; end if;
  v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);
  v_needle := $needle$  end case;

  v_current_summary :=$needle$;
  v_replacement := $replacement$  end case;
  end if;

  v_current_summary :=$replacement$;
  if pg_catalog.strpos(v_definition, v_needle) = 0 then raise exception 'T10.113 comparison case tail changed'; end if;
  execute pg_catalog.replace(v_definition, v_needle, v_replacement);
end;
$migration$;

-- Dashboard provenance wrapper and entity dashboard use the same custom wall-clock bounds.
do $migration$
declare
  v_sig regprocedure;
  v_definition text;
  v_needle text;
  v_replacement text;
begin
  foreach v_sig in array array[
    'private.get_dashboard_stats_v2_base_t63(uuid,jsonb)'::regprocedure,
    'public.get_dashboard_stats_v2(uuid,jsonb)'::regprocedure,
    'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)'::regprocedure
  ] loop
    if v_sig::text like '%get_dashboard_stats_v2_base_t63%'
       and pg_catalog.to_regprocedure('private.get_dashboard_stats_v2_base_v5(uuid,jsonb)') is null then
      continue;
    end if;
    select pg_catalog.pg_get_functiondef(v_sig) into v_definition;
    v_definition := pg_catalog.replace(v_definition, E'\r\n', E'\n');
    v_needle := $needle$  case v_range
    when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
    when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
    when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
    when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
    when 'all' then v_start := null;
  end case;
  v_start_text := case
    when v_start is null then null
    else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS')
  end;$needle$;
    if pg_catalog.strpos(v_definition, v_needle) = 0 then
      v_needle := $needle$  case v_range
    when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
    when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
    when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
    when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
    when 'all' then v_start := null;
  end case;
  v_start_text := case when v_start is null then null
    else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;$needle$;
    end if;
    if v_sig::text like '%get_usage_entity_dashboard_v2%' then
      v_replacement := $replacement$  if v_range = 'custom' then
    v_start := (v_query ->> 'start')::date::timestamp;
    v_end := least(((v_query ->> 'end')::date + 1)::timestamp - interval '1 second', v_now);
  else
    case v_range
      when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
      when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
      when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
      when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
      when 'all' then v_start := null;
    end case;
  end if;
  v_start_text := case when v_start is null then null else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;$replacement$;
    else
      v_replacement := $replacement$  if v_range = 'custom' then
    v_start := (v_query ->> 'start')::date::timestamp;
  else
    case v_range
      when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
      when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
      when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
      when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
      when 'all' then v_start := null;
    end case;
  end if;
  v_start_text := case when v_start is null then null else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;$replacement$;
    end if;
    if pg_catalog.strpos(v_definition, v_needle) = 0 then raise exception 'T10.113 public range seam changed for %', v_sig; end if;
    v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);
    if v_sig::text like '%get_dashboard_stats_v2%' then
      v_definition := pg_catalog.replace(
        v_definition,
        $needle$  v_end_text := pg_catalog.to_char(v_now, 'YYYY-MM-DD HH24:MI:SS');$needle$,
        $replacement$  v_end_text := pg_catalog.to_char(
    case when v_range = 'custom'
      then least(((v_query ->> 'end')::date + 1)::timestamp - interval '1 second', v_now)
      else v_now end,
    'YYYY-MM-DD HH24:MI:SS'
  );$replacement$
      );
    end if;
    execute v_definition;
  end loop;
end;
$migration$;

-- A custom single-day entity peak uses hour buckets just like today.
do $migration$
declare
  v_definition text;
  v_needle text := $needle$case when v_range = 'today' then pg_catalog.substr(t.timestamp, 12, 2) || ':00'$needle$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)'::regprocedure
  ) into v_definition;
  v_definition := pg_catalog.replace(v_definition, E'\r\n', E'\n');
  if pg_catalog.strpos(v_definition, v_needle) = 0 then raise exception 'T10.113 entity peak seam changed'; end if;
  execute pg_catalog.replace(
    v_definition,
    v_needle,
    $replacement$case when v_range = 'today' or (v_range = 'custom' and v_query ->> 'start' = v_query ->> 'end') then pg_catalog.substr(t.timestamp, 12, 2) || ':00'$replacement$
  );
end;
$migration$;

-- Heatmaps historically show the current calendar year independently of the
-- selected preset. Custom ranges are different: their calendar is part of the
-- query identity and must neither leak earlier dates nor drop a prior year.
do $migration$
declare
  v_sig regprocedure;
  v_definition text;
  v_needle text := $needle$      and public.immutable_date_parse(t.timestamp) >= pg_catalog.date_trunc('year', v_now)::date$needle$;
  v_replacement text := $replacement$      and public.immutable_date_parse(t.timestamp) >= case
        when v_range = 'custom' then (v_query ->> 'start')::date
        else pg_catalog.date_trunc('year', v_now)::date
      end$replacement$;
begin
  foreach v_sig in array array[
    coalesce(
      pg_catalog.to_regprocedure('private.get_dashboard_stats_v2_base_v5(uuid,jsonb)'),
      pg_catalog.to_regprocedure('private.get_dashboard_stats_v2_base_t63(uuid,jsonb)')
    ),
    pg_catalog.to_regprocedure('public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)')
  ] loop
    if v_sig is null then raise exception 'T10.113 heatmap target is missing'; end if;
    select pg_catalog.pg_get_functiondef(v_sig) into v_definition;
    if pg_catalog.strpos(v_definition, v_needle) = 0 then
      raise exception 'T10.113 heatmap range seam changed for %', v_sig;
    end if;
    execute pg_catalog.replace(v_definition, v_needle, v_replacement);
  end loop;
end;
$migration$;

revoke execute on function private.tokenledger_normalize_query_v2_pre_custom(jsonb) from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_normalize_query_v2(jsonb) from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_custom_bounds_v2(jsonb) from public, anon, authenticated, service_role;

grant execute on function public.get_dashboard_stats_v2(uuid,jsonb) to authenticated;
grant execute on function public.get_usage_comparison_v2(uuid,jsonb) to authenticated;
grant execute on function public.get_usage_details_v2(uuid,jsonb,text,integer) to authenticated;
grant execute on function public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer) to authenticated;
