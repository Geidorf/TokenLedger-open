-- TokenLedger Stats v2 cloud capabilities.
--
-- Adds keyset usage details, equal-progress comparison, and entity dashboard
-- RPCs without changing the existing get_dashboard_stats signatures. The
-- migration is additive and safe for older desktop/Android clients.

-- Keep date parsing truly immutable. A direct text-to-date cast is only
-- STABLE because it can depend on DateStyle, which also makes it unsafe as an
-- indexed expression. TokenLedger timestamps always start with ISO YYYY-MM-DD.
create or replace function public.immutable_date_parse(val text)
returns date
language plpgsql immutable
set search_path = ''
as $$
begin
  if val !~ '^\d{4}-\d{2}-\d{2}' then
    return null;
  end if;
  return pg_catalog.make_date(
    pg_catalog.substr(val, 1, 4)::integer,
    pg_catalog.substr(val, 6, 2)::integer,
    pg_catalog.substr(val, 9, 2)::integer
  );
exception when others then
  return null;
end;
$$;

-- Supabase's 2026 Data API defaults require explicit grants. Keep anon out,
-- expose only the base-table operations used by authenticated sync clients,
-- and let RLS remain the row-level boundary.
revoke all privileges on table public.token_logs from anon;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on table public.token_logs to authenticated, service_role;
grant usage, select on sequence public.token_logs_id_seq to authenticated, service_role;

-- Recreate the base-table policies with a scalar subselect so auth.uid() is
-- initialized once per statement instead of once per row on large sync sets.
drop policy if exists "token_logs_select_own" on public.token_logs;
drop policy if exists "token_logs_insert_own" on public.token_logs;
drop policy if exists "token_logs_update_own" on public.token_logs;
drop policy if exists "token_logs_delete_own" on public.token_logs;

create policy "token_logs_select_own"
  on public.token_logs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "token_logs_insert_own"
  on public.token_logs
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "token_logs_update_own"
  on public.token_logs
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "token_logs_delete_own"
  on public.token_logs
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Equality predicates lead, then the timestamp/id keyset range. Existing
-- indexes remain for compatibility; these cover the new detail/drill paths.
create index if not exists token_logs_user_time_id_idx
  on public.token_logs (user_id, timestamp desc, id desc);

create index if not exists token_logs_user_machine_time_id_idx
  on public.token_logs (user_id, machine_id, timestamp desc, id desc);

create index if not exists token_logs_user_tool_time_id_idx
  on public.token_logs (user_id, tool, timestamp desc, id desc);

create index if not exists token_logs_user_model_time_id_idx
  on public.token_logs (user_id, model, timestamp desc, id desc);

create index if not exists token_logs_user_tool_model_time_id_idx
  on public.token_logs (user_id, tool, model, timestamp desc, id desc);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Internal summary helper. It has no public execution grant and every public
-- caller performs auth.uid() validation before invoking it.
create or replace function private.tokenledger_usage_summary_v1(
  p_user uuid,
  p_start text,
  p_end text,
  p_machine text,
  p_tool text,
  p_model text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
      and (p_start is null or t.timestamp >= p_start)
      and (p_end is null or t.timestamp <= p_end)
      and (p_machine is null or t.machine_id = p_machine)
      and (p_tool is null or t.tool = p_tool)
      and (p_model is null or t.model = p_model)
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
    'avgTokensPerReq', case
      when agg.requests > 0 then round(agg.total_tokens::numeric / agg.requests, 0)::bigint
      else 0
    end
  )
  from agg;
$$;

revoke execute on function private.tokenledger_usage_summary_v1(uuid, text, text, text, text, text)
  from public, anon, authenticated;

-- Dense relative series helper. Buckets intentionally use the same labels for
-- current and previous periods so clients can overlay them without matching
-- unrelated calendar dates.
create or replace function private.tokenledger_usage_series_v1(
  p_user uuid,
  p_start timestamp,
  p_end timestamp,
  p_bucket text,
  p_machine text,
  p_tool text,
  p_model text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with slots as (
    select
      g as bucket_index,
      case p_bucket
        when 'hour' then lpad(g::text, 2, '0') || ':00'
        else 'D' || lpad((g + 1)::text, 2, '0')
      end as bucket
    from generate_series(
      0,
      case p_bucket
        when 'hour' then greatest(0, least(23, extract(hour from p_end)::integer))
        else greatest(0, (p_end::date - p_start::date))
      end
    ) as g
  ), aggregated as (
    select
      case p_bucket
        when 'hour' then case
          when t.timestamp ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
            then substr(t.timestamp, 12, 2)::integer
          else null
        end
        else public.immutable_date_parse(t.timestamp) - p_start::date
      end as bucket_index,
      sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      sum(t.requests)::bigint as requests,
      sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and t.timestamp >= to_char(p_start, 'YYYY-MM-DD HH24:MI:SS')
      and t.timestamp <= to_char(p_end, 'YYYY-MM-DD HH24:MI:SS')
      and (p_machine is null or t.machine_id = p_machine)
      and (p_tool is null or t.tool = p_tool)
      and (p_model is null or t.model = p_model)
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bucket', s.bucket,
        'tokens', coalesce(a.tokens, 0),
        'requests', coalesce(a.requests, 0),
        'cost', coalesce(a.cost, 0)
      )
      order by s.bucket_index
    ),
    '[]'::jsonb
  )
  from slots s
  left join aggregated a using (bucket_index);
$$;

revoke execute on function private.tokenledger_usage_series_v1(uuid, timestamp, timestamp, text, text, text, text)
  from public, anon, authenticated;

drop function if exists public.get_usage_details_v1(uuid, text, text, text, text, text, text, integer);

create or replace function public.get_usage_details_v1(
  p_user uuid,
  p_range text default 'today',
  p_machine text default null,
  p_tool text default null,
  p_model text default null,
  p_timezone text default 'UTC',
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_range text := lower(coalesce(nullif(p_range, ''), 'today'));
  v_timezone text := coalesce(nullif(p_timezone, ''), 'UTC');
  v_now timestamp;
  v_start timestamp;
  v_end timestamp;
  v_start_text text;
  v_end_text text;
  v_machine text := nullif(nullif(p_machine, ''), 'all_cloud');
  v_tool text := nullif(p_tool, '');
  v_model text := nullif(p_model, '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_cursor_parts text[];
  v_cursor_timestamp text;
  v_cursor_id bigint;
  v_items jsonb;
  v_has_more boolean := false;
  v_last_timestamp text;
  v_last_id bigint;
  v_next_cursor text;
  v_total_count bigint;
  v_summary jsonb;
  v_tools jsonb;
  v_models jsonb;
  v_machines jsonb;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user then
    raise exception 'get_usage_details_v1: user mismatch'
      using errcode = '42501';
  end if;

  begin
    v_now := now() at time zone v_timezone;
  exception when others then
    v_timezone := 'UTC';
    v_now := now() at time zone v_timezone;
  end;

  v_end := v_now;
  case v_range
    when 'today' then v_start := date_trunc('day', v_now);
    when 'week' then v_start := date_trunc('week', v_now);
    when 'month' then v_start := date_trunc('month', v_now);
    when 'year' then v_start := date_trunc('year', v_now);
    when 'all' then v_start := null;
    else
      raise exception 'get_usage_details_v1: invalid range %', v_range
        using errcode = '22023';
  end case;

  v_start_text := case when v_start is null then null else to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;
  v_end_text := to_char(v_end, 'YYYY-MM-DD HH24:MI:SS');

  if p_cursor is not null and p_cursor <> '' then
    begin
      v_cursor_parts := string_to_array(p_cursor, '.');
      if array_length(v_cursor_parts, 1) <> 3 or v_cursor_parts[1] <> 'v1' then
        raise exception 'invalid cursor';
      end if;
      v_cursor_timestamp := convert_from(decode(v_cursor_parts[2], 'hex'), 'UTF8');
      v_cursor_id := v_cursor_parts[3]::bigint;
      if v_cursor_timestamp !~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' or v_cursor_id < 0 then
        raise exception 'invalid cursor payload';
      end if;
    exception when others then
      raise exception 'get_usage_details_v1: invalid cursor'
        using errcode = '22023';
    end;
  end if;

  select count(*)::bigint
    into v_total_count
    from public.token_logs t
   where t.user_id = p_user
     and (v_start_text is null or t.timestamp >= v_start_text)
     and t.timestamp <= v_end_text
     and (v_machine is null or t.machine_id = v_machine)
     and (v_tool is null or t.tool = v_tool)
     and (v_model is null or t.model = v_model);

  v_summary := private.tokenledger_usage_summary_v1(
    p_user, v_start_text, v_end_text, v_machine, v_tool, v_model
  );

  with candidates as (
    select
      t.id,
      t.tool,
      t.model,
      t.input_tokens,
      t.output_tokens,
      t.cached_tokens,
      coalesce(t.cache_write_tokens, 0) as cache_write_tokens,
      coalesce(t.cost_usd, 0) as cost_usd,
      t.timestamp,
      t.session_id,
      t.machine_id,
      t.requests,
      row_number() over (order by t.timestamp desc, t.id desc) as row_number
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (v_machine is null or t.machine_id = v_machine)
      and (v_tool is null or t.tool = v_tool)
      and (v_model is null or t.model = v_model)
      and (
        v_cursor_timestamp is null
        or t.timestamp < v_cursor_timestamp
        or (t.timestamp = v_cursor_timestamp and t.id < v_cursor_id)
      )
    order by t.timestamp desc, t.id desc
    limit v_limit + 1
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'tool', c.tool,
          'model', c.model,
          'inputTokens', c.input_tokens,
          'outputTokens', c.output_tokens,
          'cachedTokens', c.cached_tokens,
          'cacheWriteTokens', c.cache_write_tokens,
          'cost', c.cost_usd,
          'timestamp', c.timestamp,
          'sessionId', c.session_id,
          'machineId', c.machine_id,
          'requests', c.requests
        )
        order by c.timestamp desc, c.id desc
      ) filter (where c.row_number <= v_limit),
      '[]'::jsonb
    ),
    count(*) > v_limit,
    max(c.timestamp) filter (where c.row_number = v_limit),
    max(c.id) filter (where c.row_number = v_limit)
  into v_items, v_has_more, v_last_timestamp, v_last_id
  from candidates c;

  if v_has_more and v_last_timestamp is not null and v_last_id is not null then
    v_next_cursor := 'v1.' || encode(convert_to(v_last_timestamp, 'UTF8'), 'hex') || '.' || v_last_id::text;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('value', f.value, 'count', f.count) order by f.count desc, f.value), '[]'::jsonb)
    into v_tools
    from (
      select t.tool as value, count(*)::bigint as count
      from public.token_logs t
      where t.user_id = p_user
        and (v_start_text is null or t.timestamp >= v_start_text)
        and t.timestamp <= v_end_text
        and (v_machine is null or t.machine_id = v_machine)
        and (v_model is null or t.model = v_model)
      group by t.tool
    ) f;

  select coalesce(jsonb_agg(jsonb_build_object('value', f.value, 'count', f.count) order by f.count desc, f.value), '[]'::jsonb)
    into v_models
    from (
      select t.model as value, count(*)::bigint as count
      from public.token_logs t
      where t.user_id = p_user
        and (v_start_text is null or t.timestamp >= v_start_text)
        and t.timestamp <= v_end_text
        and (v_machine is null or t.machine_id = v_machine)
        and (v_tool is null or t.tool = v_tool)
      group by t.model
    ) f;

  select coalesce(jsonb_agg(jsonb_build_object('value', f.value, 'count', f.count) order by f.count desc, f.value), '[]'::jsonb)
    into v_machines
    from (
      select t.machine_id as value, count(*)::bigint as count
      from public.token_logs t
      where t.user_id = p_user
        and (v_start_text is null or t.timestamp >= v_start_text)
        and t.timestamp <= v_end_text
        and (v_tool is null or t.tool = v_tool)
        and (v_model is null or t.model = v_model)
        and t.machine_id is not null
        and t.machine_id <> ''
      group by t.machine_id
    ) f;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', v_next_cursor,
    'hasMore', v_has_more,
    'totalCount', v_total_count,
    'filteredSummary', v_summary,
    'availableFilters', jsonb_build_object(
      'tools', v_tools,
      'models', v_models,
      'machines', v_machines
    ),
    'granularity', 'hour',
    'meta', jsonb_build_object(
      'contractVersion', 2,
      'generatedAt', now(),
      'timezone', v_timezone,
      'query', jsonb_build_object(
        'range', v_range,
        'timezone', v_timezone,
        'machine', v_machine,
        'tool', v_tool,
        'model', v_model,
        'tokenMode', 'effective'
      )
    )
  );
end;
$$;

revoke execute on function public.get_usage_details_v1(uuid, text, text, text, text, text, text, integer)
  from public, anon;
grant execute on function public.get_usage_details_v1(uuid, text, text, text, text, text, text, integer)
  to authenticated, service_role;

drop function if exists public.get_usage_comparison_v1(uuid, text, text, text, text, text);

create or replace function public.get_usage_comparison_v1(
  p_user uuid,
  p_range text default 'today',
  p_machine text default null,
  p_tool text default null,
  p_model text default null,
  p_timezone text default 'UTC'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_range text := lower(coalesce(nullif(p_range, ''), 'today'));
  v_timezone text := coalesce(nullif(p_timezone, ''), 'UTC');
  v_now timestamp;
  v_current_start timestamp;
  v_current_end timestamp;
  v_previous_start timestamp;
  v_previous_end timestamp;
  v_previous_last_day integer;
  v_common_day integer;
  v_bucket text;
  v_kind text;
  v_aligned_through text;
  v_machine text := nullif(nullif(p_machine, ''), 'all_cloud');
  v_tool text := nullif(p_tool, '');
  v_model text := nullif(p_model, '');
  v_current_summary jsonb;
  v_previous_summary jsonb;
  v_current_series jsonb;
  v_previous_series jsonb;
  v_current_tokens numeric;
  v_previous_tokens numeric;
  v_current_requests numeric;
  v_previous_requests numeric;
  v_current_cost numeric;
  v_previous_cost numeric;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user then
    raise exception 'get_usage_comparison_v1: user mismatch'
      using errcode = '42501';
  end if;

  if v_range not in ('today', 'week', 'month') then
    return null;
  end if;

  begin
    v_now := now() at time zone v_timezone;
  exception when others then
    v_timezone := 'UTC';
    v_now := now() at time zone v_timezone;
  end;

  case v_range
    when 'today' then
      v_kind := 'dayOverDay';
      v_bucket := 'hour';
      v_current_start := date_trunc('day', v_now);
      v_current_end := v_now;
      v_previous_start := v_current_start - interval '1 day';
      v_previous_end := v_current_end - interval '1 day';
      v_aligned_through := to_char(v_current_end, 'HH24:MI');
    when 'week' then
      v_kind := 'weekOverWeek';
      v_bucket := 'day';
      v_current_start := date_trunc('week', v_now);
      v_current_end := v_now;
      v_previous_start := v_current_start - interval '7 days';
      v_previous_end := v_current_end - interval '7 days';
      v_aligned_through := 'D' || (v_current_end::date - v_current_start::date + 1)::text
                           || ' ' || to_char(v_current_end, 'HH24:MI');
    when 'month' then
      v_kind := 'monthOverMonth';
      v_bucket := 'day';
      v_current_start := date_trunc('month', v_now);
      v_previous_start := v_current_start - interval '1 month';
      v_previous_last_day := extract(day from (v_current_start - interval '1 day'))::integer;
      v_common_day := least(extract(day from v_now)::integer, v_previous_last_day);
      v_current_end := v_current_start
                       + make_interval(days => v_common_day - 1)
                       + (v_now - date_trunc('day', v_now));
      v_previous_end := v_previous_start
                        + make_interval(days => v_common_day - 1)
                        + (v_now - date_trunc('day', v_now));
      v_aligned_through := 'D' || v_common_day::text || ' ' || to_char(v_current_end, 'HH24:MI');
  end case;

  v_current_summary := private.tokenledger_usage_summary_v1(
    p_user,
    to_char(v_current_start, 'YYYY-MM-DD HH24:MI:SS'),
    to_char(v_current_end, 'YYYY-MM-DD HH24:MI:SS'),
    v_machine,
    v_tool,
    v_model
  );
  v_previous_summary := private.tokenledger_usage_summary_v1(
    p_user,
    to_char(v_previous_start, 'YYYY-MM-DD HH24:MI:SS'),
    to_char(v_previous_end, 'YYYY-MM-DD HH24:MI:SS'),
    v_machine,
    v_tool,
    v_model
  );
  v_current_series := private.tokenledger_usage_series_v1(
    p_user, v_current_start, v_current_end, v_bucket, v_machine, v_tool, v_model
  );
  v_previous_series := private.tokenledger_usage_series_v1(
    p_user, v_previous_start, v_previous_end, v_bucket, v_machine, v_tool, v_model
  );

  v_current_tokens := coalesce((v_current_summary ->> 'totalTokens')::numeric, 0);
  v_previous_tokens := coalesce((v_previous_summary ->> 'totalTokens')::numeric, 0);
  v_current_requests := coalesce((v_current_summary ->> 'totalRequests')::numeric, 0);
  v_previous_requests := coalesce((v_previous_summary ->> 'totalRequests')::numeric, 0);
  v_current_cost := coalesce((v_current_summary ->> 'totalCost')::numeric, 0);
  v_previous_cost := coalesce((v_previous_summary ->> 'totalCost')::numeric, 0);

  return jsonb_build_object(
    'window', jsonb_build_object(
      'kind', v_kind,
      'timezone', v_timezone,
      'bucket', v_bucket,
      'currentStart', v_current_start at time zone v_timezone,
      'currentEnd', v_current_end at time zone v_timezone,
      'previousStart', v_previous_start at time zone v_timezone,
      'previousEnd', v_previous_end at time zone v_timezone,
      'alignedThrough', v_aligned_through
    ),
    'current', jsonb_build_object(
      'summary', v_current_summary,
      'series', v_current_series
    ),
    'previous', jsonb_build_object(
      'summary', v_previous_summary,
      'series', v_previous_series
    ),
    'delta', jsonb_build_object(
      'tokens', jsonb_build_object(
        'absolute', v_current_tokens - v_previous_tokens,
        'percent', case
          when v_previous_tokens > 0 then round((v_current_tokens - v_previous_tokens) * 100 / v_previous_tokens, 2)
          else null
        end,
        'direction', case
          when v_current_tokens = 0 and v_previous_tokens = 0 then 'flat'
          when v_previous_tokens = 0 and v_current_tokens > 0 then 'new'
          when v_current_tokens > v_previous_tokens then 'up'
          when v_current_tokens < v_previous_tokens then 'down'
          else 'flat'
        end
      ),
      'requests', jsonb_build_object(
        'absolute', v_current_requests - v_previous_requests,
        'percent', case
          when v_previous_requests > 0 then round((v_current_requests - v_previous_requests) * 100 / v_previous_requests, 2)
          else null
        end,
        'direction', case
          when v_current_requests = 0 and v_previous_requests = 0 then 'flat'
          when v_previous_requests = 0 and v_current_requests > 0 then 'new'
          when v_current_requests > v_previous_requests then 'up'
          when v_current_requests < v_previous_requests then 'down'
          else 'flat'
        end
      ),
      'cost', jsonb_build_object(
        'absolute', v_current_cost - v_previous_cost,
        'percent', case
          when v_previous_cost > 0 then round((v_current_cost - v_previous_cost) * 100 / v_previous_cost, 2)
          else null
        end,
        'direction', case
          when v_current_cost = 0 and v_previous_cost = 0 then 'flat'
          when v_previous_cost = 0 and v_current_cost > 0 then 'new'
          when v_current_cost > v_previous_cost then 'up'
          when v_current_cost < v_previous_cost then 'down'
          else 'flat'
        end
      )
    ),
    'meta', jsonb_build_object(
      'contractVersion', 2,
      'generatedAt', now(),
      'query', jsonb_build_object(
        'range', v_range,
        'timezone', v_timezone,
        'machine', v_machine,
        'tool', v_tool,
        'model', v_model,
        'tokenMode', 'effective'
      )
    )
  );
end;
$$;

revoke execute on function public.get_usage_comparison_v1(uuid, text, text, text, text, text)
  from public, anon;
grant execute on function public.get_usage_comparison_v1(uuid, text, text, text, text, text)
  to authenticated, service_role;

drop function if exists public.get_usage_entity_dashboard_v1(uuid, text, text, text, text, text);

create or replace function public.get_usage_entity_dashboard_v1(
  p_user uuid,
  p_range text default 'today',
  p_machine text default null,
  p_tool text default null,
  p_model text default null,
  p_timezone text default 'UTC'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_range text := lower(coalesce(nullif(p_range, ''), 'today'));
  v_timezone text := coalesce(nullif(p_timezone, ''), 'UTC');
  v_now timestamp;
  v_start timestamp;
  v_end timestamp;
  v_start_text text;
  v_end_text text;
  v_machine text := nullif(nullif(p_machine, ''), 'all_cloud');
  v_tool text := nullif(p_tool, '');
  v_model text := nullif(p_model, '');
  v_summary jsonb;
  v_comparison jsonb;
  v_by_tools jsonb;
  v_by_models jsonb;
  v_by_machines jsonb;
  v_heatmap jsonb;
  v_peak jsonb;
  v_activity jsonb;
  v_history_page jsonb;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user then
    raise exception 'get_usage_entity_dashboard_v1: user mismatch'
      using errcode = '42501';
  end if;

  if v_tool is null and v_model is null then
    raise exception 'get_usage_entity_dashboard_v1: tool or model is required'
      using errcode = '22023';
  end if;

  begin
    v_now := now() at time zone v_timezone;
  exception when others then
    v_timezone := 'UTC';
    v_now := now() at time zone v_timezone;
  end;

  v_end := v_now;
  case v_range
    when 'today' then v_start := date_trunc('day', v_now);
    when 'week' then v_start := date_trunc('week', v_now);
    when 'month' then v_start := date_trunc('month', v_now);
    when 'year' then v_start := date_trunc('year', v_now);
    when 'all' then v_start := null;
    else
      raise exception 'get_usage_entity_dashboard_v1: invalid range %', v_range
        using errcode = '22023';
  end case;

  v_start_text := case when v_start is null then null else to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;
  v_end_text := to_char(v_end, 'YYYY-MM-DD HH24:MI:SS');
  v_summary := private.tokenledger_usage_summary_v1(
    p_user, v_start_text, v_end_text, v_machine, v_tool, v_model
  );
  v_comparison := public.get_usage_comparison_v1(
    p_user, v_range, v_machine, v_tool, v_model, v_timezone
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'value', d.value,
        'tokens', d.tokens,
        'inputTokens', d.input_tokens,
        'outputTokens', d.output_tokens,
        'cachedTokens', d.cached_tokens,
        'cacheWriteTokens', d.cache_write_tokens,
        'requests', d.requests,
        'cost', d.cost
      ) order by d.tokens desc, d.value
    ),
    '[]'::jsonb
  )
  into v_by_tools
  from (
    select
      t.tool as value,
      sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      sum(t.input_tokens)::bigint as input_tokens,
      sum(t.output_tokens)::bigint as output_tokens,
      sum(t.cached_tokens)::bigint as cached_tokens,
      sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
      sum(t.requests)::bigint as requests,
      sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (v_machine is null or t.machine_id = v_machine)
      and (v_tool is null or t.tool = v_tool)
      and (v_model is null or t.model = v_model)
    group by t.tool
  ) d;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'value', d.value,
        'tokens', d.tokens,
        'inputTokens', d.input_tokens,
        'outputTokens', d.output_tokens,
        'cachedTokens', d.cached_tokens,
        'cacheWriteTokens', d.cache_write_tokens,
        'requests', d.requests,
        'cost', d.cost
      ) order by d.tokens desc, d.value
    ),
    '[]'::jsonb
  )
  into v_by_models
  from (
    select
      t.model as value,
      sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      sum(t.input_tokens)::bigint as input_tokens,
      sum(t.output_tokens)::bigint as output_tokens,
      sum(t.cached_tokens)::bigint as cached_tokens,
      sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
      sum(t.requests)::bigint as requests,
      sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (v_machine is null or t.machine_id = v_machine)
      and (v_tool is null or t.tool = v_tool)
      and (v_model is null or t.model = v_model)
    group by t.model
  ) d;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'value', d.value,
        'tokens', d.tokens,
        'requests', d.requests,
        'cost', d.cost
      ) order by d.tokens desc, d.value
    ),
    '[]'::jsonb
  )
  into v_by_machines
  from (
    select
      t.machine_id as value,
      sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      sum(t.requests)::bigint as requests,
      sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (v_machine is null or t.machine_id = v_machine)
      and (v_tool is null or t.tool = v_tool)
      and (v_model is null or t.model = v_model)
      and t.machine_id is not null
      and t.machine_id <> ''
    group by t.machine_id
  ) d;

  select coalesce(jsonb_object_agg(h.date, h.tokens order by h.date), '{}'::jsonb)
    into v_heatmap
    from (
      select
        public.immutable_date_parse(t.timestamp)::text as date,
        sum(t.input_tokens + t.output_tokens)::bigint as tokens
      from public.token_logs t
      where t.user_id = p_user
        and public.immutable_date_parse(t.timestamp) >= date_trunc('year', v_now)::date
        and t.timestamp <= v_end_text
        and (v_machine is null or t.machine_id = v_machine)
        and (v_tool is null or t.tool = v_tool)
        and (v_model is null or t.model = v_model)
      group by 1
    ) h;

  select coalesce(
    jsonb_build_object(
      'bucket', p.bucket,
      'tokens', p.tokens,
      'requests', p.requests,
      'cost', p.cost
    ),
    '{}'::jsonb
  )
  into v_peak
  from (
    select
      case
        when v_range = 'today' then substr(t.timestamp, 12, 2) || ':00'
        else public.immutable_date_parse(t.timestamp)::text
      end as bucket,
      sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      sum(t.requests)::bigint as requests,
      sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (v_machine is null or t.machine_id = v_machine)
      and (v_tool is null or t.tool = v_tool)
      and (v_model is null or t.model = v_model)
      and t.timestamp ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
    group by 1
    order by tokens desc, bucket
    limit 1
  ) p;

  v_peak := coalesce(v_peak, '{}'::jsonb);

  select jsonb_build_object(
    'activeDays', count(distinct public.immutable_date_parse(t.timestamp)),
    'firstSeenAt', min(t.timestamp),
    'lastSeenAt', max(t.timestamp)
  )
  into v_activity
  from public.token_logs t
  where t.user_id = p_user
    and (v_start_text is null or t.timestamp >= v_start_text)
    and t.timestamp <= v_end_text
    and (v_machine is null or t.machine_id = v_machine)
    and (v_tool is null or t.tool = v_tool)
    and (v_model is null or t.model = v_model);

  v_history_page := public.get_usage_details_v1(
    p_user, v_range, v_machine, v_tool, v_model, v_timezone, null, 20
  );

  return jsonb_build_object(
    'entity', jsonb_build_object(
      'kind', case when v_model is not null then 'model' else 'tool' end,
      'tool', v_tool,
      'model', v_model
    ),
    'summary', v_summary,
    'comparison', v_comparison,
    'composition', jsonb_build_object(
      'tools', v_by_tools,
      'models', v_by_models,
      'machines', v_by_machines
    ),
    'heatmap', v_heatmap,
    'peak', v_peak,
    'activity', v_activity,
    'historyPage', v_history_page,
    'granularity', 'hour',
    'meta', jsonb_build_object(
      'contractVersion', 2,
      'generatedAt', now(),
      'timezone', v_timezone,
      'query', jsonb_build_object(
        'range', v_range,
        'timezone', v_timezone,
        'machine', v_machine,
        'tool', v_tool,
        'model', v_model,
        'tokenMode', 'effective'
      )
    )
  );
end;
$$;

revoke execute on function public.get_usage_entity_dashboard_v1(uuid, text, text, text, text, text)
  from public, anon;
grant execute on function public.get_usage_entity_dashboard_v1(uuid, text, text, text, text, text)
  to authenticated, service_role;

comment on function public.get_usage_details_v1(uuid, text, text, text, text, text, text, integer)
  is 'TokenLedger v2 keyset usage details; cloud rows have hourly aggregate granularity.';
comment on function public.get_usage_comparison_v1(uuid, text, text, text, text, text)
  is 'TokenLedger v2 equal-progress day/week/month comparison.';
comment on function public.get_usage_entity_dashboard_v1(uuid, text, text, text, text, text)
  is 'TokenLedger v2 tool/model drill dashboard.';
