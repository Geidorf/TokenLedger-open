-- T6.3: add an optional, query-bound machine distribution to Stats v2.
--
-- Keep the existing dashboard implementation intact behind a non-public
-- base function. The public wrapper adds one aggregate over token_logs and
-- preserves the original response shape for every existing consumer.

alter function public.get_dashboard_stats_v2(uuid, jsonb)
  rename to get_dashboard_stats_v2_base_t63;
alter function public.get_dashboard_stats_v2_base_t63(uuid, jsonb)
  set schema private;

revoke execute on function private.get_dashboard_stats_v2_base_t63(uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.get_dashboard_stats_v2(
  p_user uuid,
  p_query jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query jsonb;
  v_range text;
  v_timezone text;
  v_now timestamp;
  v_start timestamp;
  v_start_text text;
  v_end_text text;
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text;
  v_distribution jsonb;
  v_response jsonb;
begin
  if p_user is null or (select auth.uid()) is distinct from p_user then
    raise exception 'get_dashboard_stats_v2: user mismatch'
      using errcode = '42501';
  end if;

  v_query := private.tokenledger_normalize_query_v2(p_query);
  v_range := v_query ->> 'range';
  v_timezone := v_query ->> 'timezone';
  v_now := pg_catalog.now() at time zone v_timezone;
  v_end_text := pg_catalog.to_char(v_now, 'YYYY-MM-DD HH24:MI:SS');
  v_search := v_query ->> 'search';

  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines
  from pg_catalog.jsonb_array_elements_text(v_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools
  from pg_catalog.jsonb_array_elements_text(v_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models
  from pg_catalog.jsonb_array_elements_text(v_query -> 'models') as e(value);

  case v_range
    when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
    when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
    when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
    when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
    when 'all' then v_start := null;
  end case;
  v_start_text := case
    when v_start is null then null
    else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS')
  end;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'value', d.value,
        'tokens', d.tokens,
        'inputTokens', d.input_tokens,
        'outputTokens', d.output_tokens,
        'cachedTokens', d.cached_tokens,
        'cacheWriteTokens', d.cache_write_tokens,
        'requests', d.requests,
        'cost', d.cost
      )
      order by d.tokens desc, pg_catalog.convert_to(d.value, 'UTF8')
    ),
    '[]'::jsonb
  )
  into v_distribution
  from (
    select
      t.machine_id as value,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      pg_catalog.sum(t.input_tokens)::bigint as input_tokens,
      pg_catalog.sum(t.output_tokens)::bigint as output_tokens,
      pg_catalog.sum(t.cached_tokens)::bigint as cached_tokens,
      pg_catalog.sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
      pg_catalog.sum(t.requests)::bigint as requests,
      pg_catalog.sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(
        v_search,
        t.tool,
        t.model,
        t.machine_id,
        t.session_id
      )
      and t.machine_id is not null
      and t.machine_id <> ''
    group by t.machine_id
  ) d;

  v_response := private.get_dashboard_stats_v2_base_t63(p_user, p_query);
  return v_response || pg_catalog.jsonb_build_object(
    'machineDistribution',
    v_distribution
  );
end;
$$;

revoke execute on function public.get_dashboard_stats_v2(uuid, jsonb)
  from public, anon;
grant execute on function public.get_dashboard_stats_v2(uuid, jsonb)
  to authenticated, service_role;
