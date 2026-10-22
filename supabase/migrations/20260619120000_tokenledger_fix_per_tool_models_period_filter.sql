-- Migration: Fix per-tool model breakdown to honor the selected statistics period.
--
-- Bug: In get_dashboard_stats, the per-tool `models` sub-aggregation (used by the
-- tool detail card on desktop and Android) summed model tokens across ALL TIME,
-- while the enclosing tool row (and tool.total) was period-scoped. As a result the
-- model rows could vastly exceed the tool total, producing percentages well over
-- 100% (e.g. 32112%) and a model distribution that did not match the period header.
--
-- Both code paths were affected:
--   * Path A (per-machine, base table token_logs): missing
--     `(public.immutable_date_parse(timestamp)) >= v_start_date`.
--   * Path B (aggregate across machines, materialized views): missing
--     `date >= v_start_date`.
--
-- The per-tool `heatmap` sub-aggregation intentionally remains all-time (heatmaps
-- show full history), so only the `models` sub-aggregations are changed here. Only
-- get_dashboard_stats is re-created (via create or replace); the materialized views
-- and other functions are unchanged.

create or replace function public.get_dashboard_stats(
  p_user uuid,
  p_range text default 'today',
  p_machine text default null,
  p_timezone text default 'UTC'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_machine_filter boolean := p_machine is not null
                              and p_machine <> ''
                              and p_machine <> 'all_cloud';
  v_start_date date;
  v_today date;
  v_timezone text := coalesce(nullif(p_timezone, ''), 'UTC');
  v_now timestamp;
  v_trend_bucket text;  -- 'hour' | 'day' | 'month'
  v_dirty_generation bigint;
  v_refreshed_generation bigint;
  v_last_refreshed_at timestamptz;
  v_result jsonb;
begin
  -- Authorization: an authenticated user can only query their own dashboard.
  if auth.uid() is null or auth.uid() <> p_user then
    raise exception 'get_dashboard_stats: user mismatch (auth.uid()=%, p_user=%)',
      auth.uid(), p_user
      using errcode = '42501';
  end if;

  begin
    v_now := now() at time zone v_timezone;
  exception when others then
    v_timezone := 'UTC';
    v_now := now() at time zone v_timezone;
  end;
  v_today := v_now::date;

  -- Resolve range -> start_date + trend bucketing.
  case p_range
    when 'today' then
      v_start_date := v_today;
      v_trend_bucket := 'hour';
    when 'week' then
      v_start_date := date_trunc('week', v_now)::date;
      v_trend_bucket := 'day';
    when 'month' then
      v_start_date := date_trunc('month', v_now)::date;
      v_trend_bucket := 'day';
    when 'year' then
      v_start_date := date_trunc('year', v_now)::date;
      v_trend_bucket := 'month';
    else
      v_start_date := '1900-01-01'::date;
      v_trend_bucket := 'day';
  end case;

  if v_machine_filter then
    ---------------------------------------------------------------------
    -- Path A: per-machine aggregate. token_logs has machine_id, the mat
    -- views do not, so we run a one-shot GROUP BY against the base table.
    ---------------------------------------------------------------------
    select jsonb_build_object(
      'summary', (
        with agg as (
          select
            coalesce(sum(t.input_tokens + t.output_tokens), 0)::bigint as total_tokens,
            coalesce(sum(t.input_tokens), 0)::bigint as input_tokens,
            coalesce(sum(t.output_tokens), 0)::bigint as output_tokens,
            coalesce(sum(t.cached_tokens), 0)::bigint as cached_tokens,
            coalesce(sum(coalesce(t.cache_write_tokens, 0)), 0)::bigint as cache_write_tokens,
            coalesce(sum(coalesce(t.cost_usd, 0)), 0)::double precision as cost_usd,
            coalesce(sum(t.requests), 0)::bigint as requests
          from public.token_logs t
          where t.user_id = p_user
            and t.machine_id = p_machine
            and (public.immutable_date_parse(timestamp)) >= v_start_date
        )
        select jsonb_build_object(
          'totalTokens', agg.total_tokens,
          'inputTokens', agg.input_tokens,
          'outputTokens', agg.output_tokens,
          'cachedTokens', agg.cached_tokens,
          'cacheReadTokens', greatest(agg.cached_tokens - agg.cache_write_tokens, 0),
          'cacheWriteTokens', agg.cache_write_tokens,
          'totalCost', agg.cost_usd,
          'totalRequests', agg.requests,
          'avgTokensPerReq', case when agg.requests > 0
                                  then round((agg.total_tokens::numeric / agg.requests)::numeric, 0)::bigint
                                  else 0 end
        )
        from agg
      ),
      'tools', (
        select coalesce(jsonb_object_agg(s.tool, jsonb_build_object(
                   'name', s.tool,
                   'input', s.input_tokens,
                   'output', s.output_tokens,
                   'cached', s.cached_tokens,
                   'cacheRead', greatest(s.cached_tokens - s.cache_write_tokens, 0),
                   'cacheWrite', s.cache_write_tokens,
                   'total', s.total_tokens,
                   'cost', s.cost_usd,
                   'requests', s.requests,
                   'heatmap', s.heatmap,
                   'models', s.models
                 )), '{}'::jsonb)
        from (
          select
            t.tool,
            sum(t.input_tokens)::bigint as input_tokens,
            sum(t.output_tokens)::bigint as output_tokens,
            sum(t.cached_tokens)::bigint as cached_tokens,
            sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
            sum(t.input_tokens + t.output_tokens)::bigint as total_tokens,
            sum(coalesce(t.cost_usd, 0))::double precision as cost_usd,
            sum(t.requests)::bigint as requests,
            (
              select coalesce(jsonb_object_agg(h.date::text, h.total_tokens), '{}'::jsonb)
              from (
                select (public.immutable_date_parse(timestamp)) as date,
                       sum(t2.input_tokens + t2.output_tokens)::bigint as total_tokens
                from public.token_logs t2
                where t2.user_id = p_user
                  and t2.machine_id = p_machine
                  and t2.tool = t.tool
                group by 1
              ) h
            ) as heatmap,
            (
              select coalesce(jsonb_object_agg(m.model, m.total_tokens), '{}'::jsonb)
              from (
                select model,
                       sum(t3.input_tokens + t3.output_tokens)::bigint as total_tokens
                from public.token_logs t3
                where t3.user_id = p_user
                  and t3.machine_id = p_machine
                  and t3.tool = t.tool
                  and (public.immutable_date_parse(t3.timestamp)) >= v_start_date
                group by model
              ) m
            ) as models
          from public.token_logs t
          where t.user_id = p_user
            and t.machine_id = p_machine
            and (public.immutable_date_parse(timestamp)) >= v_start_date
          group by t.tool
        ) s
      ),
      'models', (
        select coalesce(jsonb_object_agg(s.model, jsonb_build_object(
                   'name', s.model,
                   'total', s.total_tokens,
                   'requests', s.requests,
                   'input', s.input_tokens,
                   'output', s.output_tokens,
                   'cached', s.cached_tokens,
                   'cacheWrite', s.cache_write_tokens,
                   'cost', s.cost_usd,
                   'tool', s.tool,
                   'heatmap', s.heatmap
                 )), '{}'::jsonb)
        from (
          select
            t.model,
            max(t.tool) as tool,
            sum(t.input_tokens + t.output_tokens)::bigint as total_tokens,
            sum(t.input_tokens)::bigint as input_tokens,
            sum(t.output_tokens)::bigint as output_tokens,
            sum(t.cached_tokens)::bigint as cached_tokens,
            sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
            sum(coalesce(t.cost_usd, 0))::double precision as cost_usd,
            sum(t.requests)::bigint as requests,
            (
              select coalesce(jsonb_object_agg(h.date::text, h.total_tokens), '{}'::jsonb)
              from (
                select (public.immutable_date_parse(timestamp)) as date,
                       sum(t2.input_tokens + t2.output_tokens)::bigint as total_tokens
                from public.token_logs t2
                where t2.user_id = p_user
                  and t2.machine_id = p_machine
                  and t2.model = t.model
                group by 1
              ) h
            ) as heatmap
          from public.token_logs t
          where t.user_id = p_user
            and t.machine_id = p_machine
            and (public.immutable_date_parse(timestamp)) >= v_start_date
          group by t.model
        ) s
      ),
      'trends', (
        with bucketed as (
          select
            case v_trend_bucket
              when 'hour'  then lpad(substr(t.timestamp, 12, 2), 2, '0') || ':00'
              when 'month' then to_char((public.immutable_date_parse(t.timestamp)), 'YYYY-MM')
              else substr(t.timestamp, 1, 10)
            end as date,
            t.tool as tool,
            sum(t.input_tokens + t.output_tokens)::bigint as tokens,
            sum(t.requests)::bigint as requests
          from public.token_logs t
          where t.user_id = p_user
            and t.machine_id = p_machine
            and (public.immutable_date_parse(timestamp)) >= v_start_date
          group by 1, 2
        ),
        by_date as (
          select
            date,
            jsonb_object_agg(tool, tokens) as points,
            sum(requests)::bigint as requests
          from bucketed
          group by date
        )
        -- __requests 是保留键：移动端双曲线图（Tokens + 请求数）使用，
        -- Web 端按已知工具名取值不受影响。
        select coalesce(jsonb_agg(jsonb_build_object('date', date, '__requests', requests) || points order by date), '[]'::jsonb)
        from by_date
      ),
      'heatmap', (
        select coalesce(jsonb_object_agg(hm.date::text, hm.total_tokens), '{}'::jsonb)
        from (
          select
            (public.immutable_date_parse(timestamp)) as date,
            sum(t.input_tokens + t.output_tokens)::bigint as total_tokens
          from public.token_logs t
          where t.user_id = p_user
            and t.machine_id = p_machine
            and (public.immutable_date_parse(timestamp)) >= date_trunc('year', v_now)::date
          group by 1
        ) hm
      ),
      'history', (
        select coalesce(jsonb_agg(row_to_json(h)::jsonb), '[]'::jsonb)
        from (
          select
            id,
            tool,
            model,
            input_tokens as "inputTokens",
            output_tokens as "outputTokens",
            cached_tokens as "cachedTokens",
            coalesce(cache_write_tokens, 0) as "cacheWriteTokens",
            coalesce(cost_usd, 0) as cost,
            timestamp,
            session_id as "sessionId",
            machine_id as "machineId"
          from public.token_logs
          where user_id = p_user
            and machine_id = p_machine
          order by timestamp desc
          limit 200
        ) h
      ),
      'machines', (
        select coalesce(jsonb_agg(m.machine_id order by m.machine_id), '[]'::jsonb)
        from (
          select distinct machine_id
          from public.token_logs
          where user_id = p_user
            and machine_id is not null
            and machine_id <> ''
        ) m
      )
    ) into v_result;
  else
    ---------------------------------------------------------------------
    -- Path B: aggregate across machines via materialized views.
    ---------------------------------------------------------------------
    select jsonb_build_object(
      'summary', (
        with agg as (
          select
            coalesce(sum(total_tokens), 0)::bigint as total_tokens,
            coalesce(sum(input_tokens), 0)::bigint as input_tokens,
            coalesce(sum(output_tokens), 0)::bigint as output_tokens,
            coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
            coalesce(sum(coalesce(cache_write_tokens, 0)), 0)::bigint as cache_write_tokens,
            coalesce(sum(cost_usd), 0)::double precision as cost_usd,
            coalesce(sum(requests), 0)::bigint as requests
          from public.token_logs_daily_by_tool
          where user_id = p_user
            and date >= v_start_date
        )
        select jsonb_build_object(
          'totalTokens', agg.total_tokens,
          'inputTokens', agg.input_tokens,
          'outputTokens', agg.output_tokens,
          'cachedTokens', agg.cached_tokens,
          'cacheReadTokens', greatest(agg.cached_tokens - agg.cache_write_tokens, 0),
          'cacheWriteTokens', agg.cache_write_tokens,
          'totalCost', agg.cost_usd,
          'totalRequests', agg.requests,
          'avgTokensPerReq', case when agg.requests > 0
                                  then round((agg.total_tokens::numeric / agg.requests)::numeric, 0)::bigint
                                  else 0 end
        )
        from agg
      ),
      'tools', (
        select coalesce(jsonb_object_agg(s.tool, jsonb_build_object(
                    'name', s.tool,
                    'input', s.input_tokens,
                    'output', s.output_tokens,
                    'cached', s.cached_tokens,
                    'cacheRead', greatest(s.cached_tokens - s.cache_write_tokens, 0),
                    'cacheWrite', s.cache_write_tokens,
                    'total', s.total_tokens,
                    'cost', s.cost_usd,
                    'requests', s.requests,
                    'heatmap', s.heatmap,
                    'models', s.models
                  )), '{}'::jsonb)
        from (
          select
            t.tool,
            sum(t.input_tokens)::bigint as input_tokens,
            sum(t.output_tokens)::bigint as output_tokens,
            sum(t.cached_tokens)::bigint as cached_tokens,
            sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
            sum(t.total_tokens)::bigint as total_tokens,
            sum(t.cost_usd)::double precision as cost_usd,
            sum(t.requests)::bigint as requests,
            (
              select coalesce(jsonb_object_agg(h.date::text, h.total_tokens), '{}'::jsonb)
              from public.token_logs_daily_by_tool h
              where h.user_id = p_user
                and h.tool = t.tool
            ) as heatmap,
            (
              select coalesce(jsonb_object_agg(m.model, m.total_tokens), '{}'::jsonb)
              from (
                select model, sum(total_tokens)::bigint as total_tokens
                from public.token_logs_daily_by_model
                where user_id = p_user
                  and tool = t.tool
                  and date >= v_start_date
                group by model
              ) m
            ) as models
          from public.token_logs_daily_by_tool t
          where t.user_id = p_user
            and t.date >= v_start_date
          group by t.tool
        ) s
      ),
      'models', (
        select coalesce(jsonb_object_agg(s.model, jsonb_build_object(
                    'name', s.model,
                    'total', s.total_tokens,
                    'requests', s.requests,
                    'input', s.input_tokens,
                    'output', s.output_tokens,
                    'cached', s.cached_tokens,
                    'cacheWrite', s.cache_write_tokens,
                    'cost', s.cost_usd,
                    'tool', s.tool,
                    'heatmap', s.heatmap
                  )), '{}'::jsonb)
        from (
          select
            m_outer.model,
            max(m_outer.tool) as tool,
            sum(m_outer.total_tokens)::bigint as total_tokens,
            sum(m_outer.input_tokens)::bigint as input_tokens,
            sum(m_outer.output_tokens)::bigint as output_tokens,
            sum(m_outer.cached_tokens)::bigint as cached_tokens,
            sum(m_outer.cache_write_tokens)::bigint as cache_write_tokens,
            sum(m_outer.cost_usd)::double precision as cost_usd,
            sum(m_outer.requests)::bigint as requests,
            (
              select coalesce(jsonb_object_agg(h.date::text, h.total_tokens), '{}'::jsonb)
              from (
                select date,
                       sum(total_tokens)::bigint as total_tokens
                from public.token_logs_daily_by_model
                where user_id = p_user
                  and model = m_outer.model
                group by date
              ) h
            ) as heatmap
          from public.token_logs_daily_by_model m_outer
          where user_id = p_user
            and date >= v_start_date
          group by m_outer.model
        ) s
      ),
      'trends', (
        with bucketed as (
          select *
          from (
            select
              substr(t.timestamp::text, 12, 2) || ':00' as date,
              t.tool,
              sum(t.input_tokens + t.output_tokens)::bigint as tokens,
              sum(t.requests)::bigint as requests
            from public.token_logs t
            where v_trend_bucket = 'hour'
              and t.user_id = p_user
              and (public.immutable_date_parse(t.timestamp)) >= v_start_date
            group by 1, 2
            union all
            select
              case v_trend_bucket
                when 'month' then to_char(t.date, 'YYYY-MM')
                else t.date::text
              end as date,
              t.tool,
              sum(t.total_tokens)::bigint as tokens,
              sum(t.requests)::bigint as requests
            from public.token_logs_daily_by_tool t
            where v_trend_bucket <> 'hour'
              and t.user_id = p_user
              and t.date >= v_start_date
            group by 1, 2
          ) all_buckets
        ),
        by_date as (
          select
            date,
            jsonb_object_agg(tool, tokens) as points,
            sum(requests)::bigint as requests
          from bucketed
          group by date
        )
        -- __requests 是保留键：移动端双曲线图（Tokens + 请求数）使用，
        -- Web 端按已知工具名取值不受影响。
        select coalesce(jsonb_agg(jsonb_build_object('date', date, '__requests', requests) || points order by date), '[]'::jsonb)
        from by_date
      ),
      'heatmap', (
        select coalesce(jsonb_object_agg(h.date::text, h.total_tokens), '{}'::jsonb)
        from public.token_logs_year_heatmap h
        where h.user_id = p_user
          and h.date >= date_trunc('year', v_now)::date
      ),
      'history', (
        select coalesce(jsonb_agg(row_to_json(h)::jsonb), '[]'::jsonb)
        from (
          select
            id,
            tool,
            model,
            input_tokens as "inputTokens",
            output_tokens as "outputTokens",
            cached_tokens as "cachedTokens",
            coalesce(cache_write_tokens, 0) as "cacheWriteTokens",
            coalesce(cost_usd, 0) as cost,
            timestamp,
            session_id as "sessionId",
            machine_id as "machineId"
          from public.token_logs
          where user_id = p_user
          order by timestamp desc
          limit 200
        ) h
      ),
      'machines', (
        select coalesce(jsonb_agg(m.machine_id order by m.machine_id), '[]'::jsonb)
        from (
          select distinct machine_id
          from public.token_logs
          where user_id = p_user
            and machine_id is not null
            and machine_id <> ''
        ) m
      )
    ) into v_result;
  end if;

  select dirty_generation, refreshed_generation, last_refreshed_at
    into v_dirty_generation, v_refreshed_generation, v_last_refreshed_at
    from public.sync_state
   where id = 1;

  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'meta', jsonb_build_object(
      'generatedAt', now(),
      'lastRefreshedAt', v_last_refreshed_at,
      'timezone', v_timezone,
      'range', p_range,
      'machine', p_machine,
      'stale', coalesce(v_dirty_generation > v_refreshed_generation, true)
    )
  );
end;
$$;

revoke execute on function public.get_dashboard_stats(uuid, text, text, text) from public, anon;
grant execute on function public.get_dashboard_stats(uuid, text, text, text) to authenticated, service_role;
