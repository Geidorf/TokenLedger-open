-- 云端热力图逐日记录数与费用、活动节律接口。
--
-- 1. get_dashboard_stats_v2 在顶层与每个 tools[*]、models[*] 的 heatmap 旁
--    增加 heatmapRequests（当天 requests 之和）与 heatmapCost（当天 cost_usd
--    之和，6 位小数）。两者与同一对象 heatmap 的日期键完全一致；某个对象只要
--    有一天的值不可信（记录数 < 1、费用缺失/非法/历史 0/溢出），就整项不输出，
--    不补 0、不只加已知部分。契约见 docs/contracts/dashboard-stats-v2.md §2.6。
--    做法：新增私有辅助函数读取已生成的响应与同一 canonical 过滤，只在
--    `return v_response;` 前合并，旧字段与旧计算不变。
-- 2. 新增 public.get_activity_rhythm_v1(jsonb)：按小时聚合（工具、日期×小时、
--    小时×模型、日期×模型），供 Android 活动节律视图。云端只有小时聚合，
--    没有会话与单条请求大小。契约见 docs/contracts/activity-rhythm-cloud-v1.md。

create or replace function private.tokenledger_heatmap_metrics_v1(
  p_user uuid,
  p_query jsonb,
  p_response jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_range text := p_query ->> 'range';
  v_timezone text := p_query ->> 'timezone';
  v_now timestamp;
  v_start timestamp;
  v_start_text text;
  v_end_text text;
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text := p_query ->> 'search';
  v_top jsonb;
  v_tool_extras jsonb;
  v_model_extras jsonb;
  v_result jsonb := p_response;
begin
  if p_response is null or pg_catalog.jsonb_typeof(p_response) <> 'object' then
    return p_response;
  end if;

  v_now := pg_catalog.now() at time zone v_timezone;
  v_end_text := pg_catalog.to_char(
    case when v_range = 'custom'
      then least(((p_query ->> 'end')::date + 1)::timestamp - interval '1 second', v_now)
      else v_now end,
    'YYYY-MM-DD HH24:MI:SS'
  );
  -- 顶层 heatmap 在预设范围下是年初至今，工具与模型 heatmap 跟随所选范围；
  -- 所有起点都是本地零点，取两者中较早者即可覆盖每个对象的全部日期键。
  v_start := case v_range
    when 'custom' then least(
      (p_query ->> 'start')::date::timestamp,
      pg_catalog.date_trunc('year', v_now)
    )
    when 'all' then null
    else pg_catalog.date_trunc('year', v_now)
  end;
  if v_range = 'week' then
    v_start := least(v_start, pg_catalog.date_trunc('week', v_now));
  end if;
  v_start_text := case when v_start is null then null
    else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;

  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines
  from pg_catalog.jsonb_array_elements_text(p_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools
  from pg_catalog.jsonb_array_elements_text(p_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models
  from pg_catalog.jsonb_array_elements_text(p_query -> 'models') as e(value);

  with grouped as materialized (
    select
      public.immutable_date_parse(t.timestamp)::text as local_date,
      t.tool,
      t.model,
      pg_catalog.sum(t.requests::numeric) as requests,
      pg_catalog.bool_or(
        t.cost_usd is null
        or t.cost_usd <= 0::double precision
        or t.cost_usd = 'Infinity'::double precision
        or t.cost_usd = 'NaN'::double precision
      ) as cost_unknown,
      pg_catalog.sum(
        case
          when t.cost_usd > 0::double precision
            and t.cost_usd < 'Infinity'::double precision
            then t.cost_usd::numeric
          else 0::numeric
        end
      ) as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(
        v_search, t.tool, t.model, t.machine_id, t.session_id
      )
    group by 1, 2, 3
  ), objects as (
    select 'summary'::text as kind, ''::text as key, p_response -> 'heatmap' as heatmap
    where pg_catalog.jsonb_typeof(p_response -> 'heatmap') = 'object'
    union all
    select 'tool', e.key, e.value -> 'heatmap'
    from pg_catalog.jsonb_each(
      case when pg_catalog.jsonb_typeof(p_response -> 'tools') = 'object'
        then p_response -> 'tools' else '{}'::jsonb end
    ) as e(key, value)
    where pg_catalog.jsonb_typeof(e.value -> 'heatmap') = 'object'
    union all
    select 'model', e.key, e.value -> 'heatmap'
    from pg_catalog.jsonb_each(
      case when pg_catalog.jsonb_typeof(p_response -> 'models') = 'object'
        then p_response -> 'models' else '{}'::jsonb end
    ) as e(key, value)
    where pg_catalog.jsonb_typeof(e.value -> 'heatmap') = 'object'
  ), object_days as (
    select o.kind, o.key, k.local_date
    from objects o
    cross join lateral pg_catalog.jsonb_object_keys(o.heatmap) as k(local_date)
  ), per_day as (
    select
      d.kind,
      d.key,
      d.local_date,
      pg_catalog.count(g.local_date) as matched_groups,
      pg_catalog.sum(g.requests) as requests,
      coalesce(pg_catalog.bool_or(g.cost_unknown), true) as cost_unknown,
      pg_catalog.sum(g.cost) as cost
    from object_days d
    left join grouped g
      on g.local_date = d.local_date
      and (
        d.kind = 'summary'
        or (d.kind = 'tool' and g.tool = d.key)
        or (d.kind = 'model' and g.model = d.key)
      )
    group by d.kind, d.key, d.local_date
  ), per_object as (
    select
      p.kind,
      p.key,
      pg_catalog.bool_and(
        p.matched_groups > 0
        and p.requests >= 1::numeric
        and p.requests <= 9007199254740991::numeric
      ) as requests_ok,
      pg_catalog.bool_and(
        p.matched_groups > 0
        and not p.cost_unknown
        and p.cost <= 1.7976931348623157e308::numeric
      ) as cost_ok,
      pg_catalog.jsonb_object_agg(
        p.local_date,
        case when p.requests between 1::numeric and 9007199254740991::numeric
          then p.requests::bigint end
      ) as requests_map,
      pg_catalog.jsonb_object_agg(
        p.local_date,
        case when p.cost <= 1.7976931348623157e308::numeric
          then pg_catalog.round(p.cost, 6)::double precision end
      ) as cost_map
    from per_day p
    group by p.kind, p.key
  ), extras as (
    select
      o.kind,
      o.key,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'heatmapRequests', case
          when po.kind is null then '{}'::jsonb
          when po.requests_ok then po.requests_map
        end,
        'heatmapCost', case
          when po.kind is null then '{}'::jsonb
          when po.cost_ok then po.cost_map
        end
      )) as fields
    from objects o
    left join per_object po on po.kind = o.kind and po.key = o.key
  )
  select
    (select x.fields from extras x where x.kind = 'summary'),
    coalesce(
      (select pg_catalog.jsonb_object_agg(x.key, x.fields)
        from extras x where x.kind = 'tool'),
      '{}'::jsonb
    ),
    coalesce(
      (select pg_catalog.jsonb_object_agg(x.key, x.fields)
        from extras x where x.kind = 'model'),
      '{}'::jsonb
    )
    into v_top, v_tool_extras, v_model_extras;

  if v_top is not null then
    v_result := (v_result - 'heatmapRequests' - 'heatmapCost') || v_top;
  end if;
  if pg_catalog.jsonb_typeof(v_result -> 'tools') = 'object' then
    v_result := pg_catalog.jsonb_set(
      v_result,
      '{tools}',
      coalesce(
        (select pg_catalog.jsonb_object_agg(
            e.key,
            case when pg_catalog.jsonb_typeof(e.value) = 'object'
              then (e.value - 'heatmapRequests' - 'heatmapCost')
                || coalesce(v_tool_extras -> e.key, '{}'::jsonb)
              else e.value end
          )
          from pg_catalog.jsonb_each(v_result -> 'tools') as e(key, value)),
        '{}'::jsonb
      ),
      true
    );
  end if;
  if pg_catalog.jsonb_typeof(v_result -> 'models') = 'object' then
    v_result := pg_catalog.jsonb_set(
      v_result,
      '{models}',
      coalesce(
        (select pg_catalog.jsonb_object_agg(
            e.key,
            case when pg_catalog.jsonb_typeof(e.value) = 'object'
              then (e.value - 'heatmapRequests' - 'heatmapCost')
                || coalesce(v_model_extras -> e.key, '{}'::jsonb)
              else e.value end
          )
          from pg_catalog.jsonb_each(v_result -> 'models') as e(key, value)),
        '{}'::jsonb
      ),
      true
    );
  end if;

  return v_result;
end;
$$;

revoke execute on function private.tokenledger_heatmap_metrics_v1(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- Patch the public dashboard at its single return seam. The guards abort the
-- migration if an earlier migration changed the expected definition.
do $migration$
declare
  v_signature regprocedure :=
    'public.get_dashboard_stats_v2(uuid,jsonb)'::pg_catalog.regprocedure;
  v_definition text;
  v_needle text;
  v_replacement text;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  v_definition := pg_catalog.replace(v_definition, E'\r\n', E'\n');

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = v_signature
      and p.prosecdef
      and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'heatmap metrics: dashboard must remain SECURITY DEFINER with empty search_path';
  end if;
  if (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(
          v_definition,
          '(select auth.uid()) is distinct from p_user',
          ''
        ))
  ) / pg_catalog.length('(select auth.uid()) is distinct from p_user') <> 1 then
    raise exception 'heatmap metrics: dashboard auth.uid ownership seam changed';
  end if;
  if pg_catalog.strpos(v_definition, 'tokenledger_heatmap_metrics_v1') > 0 then
    raise exception 'heatmap metrics: dashboard is already patched';
  end if;

  v_needle := $needle$
  return v_response;
end;
$needle$;
  v_replacement := $replacement$
  v_response := private.tokenledger_heatmap_metrics_v1(p_user, v_query, v_response);

  return v_response;
end;
$replacement$;
  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, '')))
      / pg_catalog.length(v_needle) <> 1 then
    raise exception 'heatmap metrics: dashboard return seam changed';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);

  execute v_definition;
end;
$migration$;

revoke execute on function public.get_dashboard_stats_v2(uuid,jsonb)
  from public, anon;
grant execute on function public.get_dashboard_stats_v2(uuid,jsonb)
  to authenticated, service_role;

comment on function public.get_dashboard_stats_v2(uuid,jsonb)
  is 'TokenLedger Stats v2 dashboard with optional daily costs, per-day heatmap record counts/costs and conservative cache provenance.';

-- ---------------------------------------------------------------------------
-- Activity rhythm (cloud) v1.
-- ---------------------------------------------------------------------------

create or replace function public.get_activity_rhythm_v1(p_query jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_query jsonb;
  v_range text;
  v_timezone text;
  v_now timestamp;
  v_today date;
  v_start timestamp;
  v_end timestamp;
  v_start_text text;
  v_end_text text;
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text;
  v_truncated boolean := false;
  v_first_date date;
  v_meta jsonb;
  v_summary jsonb;
  v_tool_rows jsonb;
  v_day_hours jsonb;
  v_model_hours jsonb;
  v_model_days jsonb;
  v_first_at text;
  v_last_at text;
  v_record_count numeric;
begin
  if v_user is null then
    raise exception 'get_activity_rhythm_v1: authentication required'
      using errcode = '42501';
  end if;

  v_query := private.tokenledger_normalize_query_v2(p_query);
  v_range := v_query ->> 'range';
  v_timezone := v_query ->> 'timezone';
  v_search := v_query ->> 'search';
  v_now := pg_catalog.now() at time zone v_timezone;
  v_today := v_now::date;

  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines
  from pg_catalog.jsonb_array_elements_text(v_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools
  from pg_catalog.jsonb_array_elements_text(v_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models
  from pg_catalog.jsonb_array_elements_text(v_query -> 'models') as e(value);

  if v_range = 'custom' then
    v_start := (v_query ->> 'start')::date::timestamp;
    v_end := least(((v_query ->> 'end')::date + 1)::timestamp - interval '1 second', v_now);
  else
    v_end := v_now;
    case v_range
      when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
      when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
      when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
      when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
      -- Same 731 local-day ceiling as custom ranges and the local contract.
      when 'all' then v_start := (v_today - 730)::timestamp;
    end case;
  end if;
  v_start_text := pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS');
  v_end_text := pg_catalog.to_char(v_end, 'YYYY-MM-DD HH24:MI:SS');

  if v_range = 'all' then
    select exists (
      select 1
      from public.token_logs t
      where t.user_id = v_user
        and t.timestamp < v_start_text
        and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
        and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
        and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
        and private.tokenledger_search_match_v2(
          v_search, t.tool, t.model, t.machine_id, t.session_id
        )
    ) into v_truncated;
  end if;

  with filtered as materialized (
    select
      t.tool,
      t.model,
      t.timestamp,
      public.immutable_date_parse(t.timestamp) as local_date,
      case when pg_catalog.substr(t.timestamp, 12, 2) ~ '^[0-9]{2}$'
          and pg_catalog.substr(t.timestamp, 12, 2)::integer between 0 and 23
        then pg_catalog.substr(t.timestamp, 12, 2)::integer
      end as local_hour,
      t.input_tokens::numeric as input_tokens,
      t.output_tokens::numeric as output_tokens,
      t.cached_tokens::numeric as cached_tokens,
      t.requests::numeric as requests
    from public.token_logs t
    where t.user_id = v_user
      and t.timestamp >= v_start_text
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(
        v_search, t.tool, t.model, t.machine_id, t.session_id
      )
  ), bucketed as (
    select * from filtered f
    where f.local_date is not null and f.local_hour is not null
  )
  select
    pg_catalog.jsonb_build_object(
      'tokens', coalesce(pg_catalog.sum(f.input_tokens + f.output_tokens), 0),
      'inputTokens', coalesce(pg_catalog.sum(f.input_tokens), 0),
      'outputTokens', coalesce(pg_catalog.sum(f.output_tokens), 0),
      'cachedTokens', coalesce(pg_catalog.sum(f.cached_tokens), 0),
      'requests', coalesce(pg_catalog.sum(f.requests), 0),
      'activeDays', pg_catalog.count(distinct f.local_date),
      'toolCount', pg_catalog.count(distinct f.tool),
      'modelCount', pg_catalog.count(distinct f.model)
    ),
    coalesce(pg_catalog.sum(f.requests), 0),
    pg_catalog.min(f.timestamp),
    pg_catalog.max(f.timestamp),
    pg_catalog.min(f.local_date),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('id', x.tool, 'tokens', x.tokens, 'requests', x.requests)
        order by x.tokens desc, x.tool collate "C"
      )
      from (
        select f2.tool,
          pg_catalog.sum(f2.input_tokens + f2.output_tokens) as tokens,
          pg_catalog.sum(f2.requests) as requests
        from filtered f2
        group by f2.tool
      ) x
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'date', x.local_date::text, 'hour', x.local_hour,
          'tokens', x.tokens, 'requests', x.requests
        )
        order by x.local_date, x.local_hour
      )
      from (
        select b.local_date, b.local_hour,
          pg_catalog.sum(b.input_tokens + b.output_tokens) as tokens,
          pg_catalog.sum(b.requests) as requests
        from bucketed b
        group by b.local_date, b.local_hour
      ) x
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'hour', x.local_hour, 'model', x.model,
          'tokens', x.tokens, 'requests', x.requests
        )
        order by x.local_hour, x.model collate "C"
      )
      from (
        select b.local_hour, b.model,
          pg_catalog.sum(b.input_tokens + b.output_tokens) as tokens,
          pg_catalog.sum(b.requests) as requests
        from bucketed b
        group by b.local_hour, b.model
      ) x
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'date', x.local_date::text, 'model', x.model,
          'tokens', x.tokens, 'requests', x.requests
        )
        order by x.local_date, x.model collate "C"
      )
      from (
        select b.local_date, b.model,
          pg_catalog.sum(b.input_tokens + b.output_tokens) as tokens,
          pg_catalog.sum(b.requests) as requests
        from bucketed b
        group by b.local_date, b.model
      ) x
    ), '[]'::jsonb)
    into
      v_summary, v_record_count, v_first_at, v_last_at, v_first_date,
      v_tool_rows, v_day_hours, v_model_hours, v_model_days
  from filtered f;

  v_meta := pg_catalog.jsonb_build_object(
    'source', 'cloud',
    'contractVersion', 1,
    'granularity', 'hour',
    'complete', true,
    'range', v_range,
    'start', case
      when v_range = 'all' and not v_truncated
        then coalesce(least(v_first_date, v_today), v_today)::text
      else v_start::date::text
    end,
    'end', v_end::date::text,
    'timezone', v_timezone,
    'rangeDayLimit', 731,
    'rangeTruncated', v_truncated,
    'recordCount', v_record_count,
    'firstRecordAt', v_first_at,
    'lastRecordAt', v_last_at,
    'query', v_query,
    'generatedAt', pg_catalog.now()
  );

  return pg_catalog.jsonb_build_object(
    'meta', v_meta,
    'summary', v_summary,
    'tools', v_tool_rows,
    'dayHours', v_day_hours,
    'modelHours', v_model_hours,
    'modelDays', v_model_days
  );
end;
$$;

revoke execute on function public.get_activity_rhythm_v1(jsonb)
  from public, anon;
grant execute on function public.get_activity_rhythm_v1(jsonb)
  to authenticated;

comment on function public.get_activity_rhythm_v1(jsonb)
  is 'TokenLedger cloud activity rhythm v1: owner-scoped hourly aggregates by tool, date x hour, hour x model and date x model. No sessions or request sizes.';
