-- TokenLedger Stats v2 canonical multi-filter/search RPCs.
--
-- This migration is additive: the legacy get_dashboard_stats and *_v1 RPCs
-- remain untouched so old desktop and Android clients continue to work. New
-- clients use explicit *_v2 names with a single p_query jsonb envelope.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

-- Equality columns lead, followed by the timestamp/id keyset range. Existing
-- single-dimension indexes remain useful for bitmap plans; this index covers
-- the common fully-scoped device + tool + model detail path.
create index if not exists token_logs_user_machine_tool_model_time_id_idx
  on public.token_logs (
    user_id,
    machine_id,
    tool,
    model,
    timestamp desc,
    id desc
  );

create or replace function private.tokenledger_ascii_trim_v2(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  select pg_catalog.btrim(p_value, E' \t\n\r');
$$;

create or replace function private.tokenledger_normalize_array_v2(
  p_value jsonb,
  p_dimension text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_text text;
  v_result jsonb;
begin
  if p_value is null then
    return '[]'::jsonb;
  end if;

  if pg_catalog.jsonb_typeof(p_value) <> 'array' then
    raise exception 'query-v2: % must be an array', p_dimension
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(p_value) > 32 then
    raise exception 'query-v2: % exceeds 32 items', p_dimension
      using errcode = '22023';
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_value)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'string' then
      raise exception 'query-v2: % item must be a string', p_dimension
        using errcode = '22023';
    end if;

    v_text := private.tokenledger_ascii_trim_v2(v_item #>> '{}');
    if v_text = '' then
      raise exception 'query-v2: % contains empty-item', p_dimension
        using errcode = '22023';
    end if;
    if pg_catalog.octet_length(v_text) > 256 then
      raise exception 'query-v2: % item exceeds 256 UTF-8 bytes', p_dimension
        using errcode = '22023';
    end if;
    if p_dimension = 'machines' and v_text in ('all', 'all_cloud') then
      raise exception 'query-v2: machines contains illegal-machine-sentinel'
        using errcode = '22023';
    end if;
  end loop;

  select coalesce(
    pg_catalog.jsonb_agg(n.value order by pg_catalog.convert_to(n.value, 'UTF8')),
    '[]'::jsonb
  )
  into v_result
  from (
    select distinct private.tokenledger_ascii_trim_v2(e.value #>> '{}') as value
    from pg_catalog.jsonb_array_elements(p_value) e(value)
  ) n;

  return v_result;
end;
$$;

create or replace function private.tokenledger_normalize_singular_v2(
  p_value jsonb,
  p_dimension text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if pg_catalog.jsonb_typeof(p_value) <> 'string' then
    raise exception 'query-v2: legacy % must be a string or null', p_dimension
      using errcode = '22023';
  end if;

  v_text := private.tokenledger_ascii_trim_v2(p_value #>> '{}');
  if v_text = '' then
    return null;
  end if;
  if pg_catalog.octet_length(v_text) > 256 then
    raise exception 'query-v2: legacy % exceeds 256 UTF-8 bytes', p_dimension
      using errcode = '22023';
  end if;
  if p_dimension = 'machine' and v_text in ('all', 'all_cloud') then
    return null;
  end if;
  return v_text;
end;
$$;

create or replace function private.tokenledger_normalize_query_v2(p_query jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_input jsonb := coalesce(p_query, '{}'::jsonb);
  v_range text := 'today';
  v_timezone text := 'UTC';
  v_token_mode text := 'effective';
  v_machines jsonb;
  v_tools jsonb;
  v_models jsonb;
  v_machine text;
  v_tool text;
  v_model text;
  v_singular_array jsonb;
  v_search text;
  v_result jsonb;
begin
  if pg_catalog.jsonb_typeof(v_input) <> 'object' then
    raise exception 'query-v2: p_query must be an object'
      using errcode = '22023';
  end if;

  if v_input ? 'range' then
    if pg_catalog.jsonb_typeof(v_input -> 'range') <> 'string' then
      raise exception 'query-v2: range must be a string'
        using errcode = '22023';
    end if;
    v_range := pg_catalog.lower(private.tokenledger_ascii_trim_v2(v_input ->> 'range'));
  end if;
  if v_range not in ('today', 'week', 'month', 'year', 'all') then
    raise exception 'query-v2: invalid range %', v_range
      using errcode = '22023';
  end if;

  if v_input ? 'timezone' then
    if pg_catalog.jsonb_typeof(v_input -> 'timezone') <> 'string' then
      raise exception 'query-v2: timezone must be a string'
        using errcode = '22023';
    end if;
    v_timezone := private.tokenledger_ascii_trim_v2(v_input ->> 'timezone');
    if v_timezone = '' then
      v_timezone := 'UTC';
    end if;
  end if;
  begin
    perform pg_catalog.timezone(v_timezone, pg_catalog.statement_timestamp());
  exception when others then
    v_timezone := 'UTC';
  end;

  if v_input ? 'tokenMode' then
    if pg_catalog.jsonb_typeof(v_input -> 'tokenMode') <> 'string' then
      raise exception 'query-v2: tokenMode must be a string'
        using errcode = '22023';
    end if;
    v_token_mode := pg_catalog.lower(private.tokenledger_ascii_trim_v2(v_input ->> 'tokenMode'));
  end if;
  if v_token_mode <> 'effective' then
    raise exception 'query-v2: unsupported tokenMode %', v_token_mode
      using errcode = '22023';
  end if;

  v_machine := case when v_input ? 'machine'
    then private.tokenledger_normalize_singular_v2(v_input -> 'machine', 'machine')
    else null end;
  v_tool := case when v_input ? 'tool'
    then private.tokenledger_normalize_singular_v2(v_input -> 'tool', 'tool')
    else null end;
  v_model := case when v_input ? 'model'
    then private.tokenledger_normalize_singular_v2(v_input -> 'model', 'model')
    else null end;

  v_machines := case when v_input ? 'machines'
    then private.tokenledger_normalize_array_v2(v_input -> 'machines', 'machines')
    else case when v_machine is null then '[]'::jsonb else pg_catalog.jsonb_build_array(v_machine) end
  end;
  v_tools := case when v_input ? 'tools'
    then private.tokenledger_normalize_array_v2(v_input -> 'tools', 'tools')
    else case when v_tool is null then '[]'::jsonb else pg_catalog.jsonb_build_array(v_tool) end
  end;
  v_models := case when v_input ? 'models'
    then private.tokenledger_normalize_array_v2(v_input -> 'models', 'models')
    else case when v_model is null then '[]'::jsonb else pg_catalog.jsonb_build_array(v_model) end
  end;

  if v_input ? 'machines' and v_input ? 'machine' then
    v_singular_array := case when v_machine is null then '[]'::jsonb else pg_catalog.jsonb_build_array(v_machine) end;
    if v_machines <> v_singular_array then
      raise exception 'query-v2: conflicting machine/machines'
        using errcode = '22023';
    end if;
  end if;
  if v_input ? 'tools' and v_input ? 'tool' then
    v_singular_array := case when v_tool is null then '[]'::jsonb else pg_catalog.jsonb_build_array(v_tool) end;
    if v_tools <> v_singular_array then
      raise exception 'query-v2: conflicting tool/tools'
        using errcode = '22023';
    end if;
  end if;
  if v_input ? 'models' and v_input ? 'model' then
    v_singular_array := case when v_model is null then '[]'::jsonb else pg_catalog.jsonb_build_array(v_model) end;
    if v_models <> v_singular_array then
      raise exception 'query-v2: conflicting model/models'
        using errcode = '22023';
    end if;
  end if;

  if v_input ? 'search' and pg_catalog.jsonb_typeof(v_input -> 'search') <> 'null' then
    if pg_catalog.jsonb_typeof(v_input -> 'search') <> 'string' then
      raise exception 'query-v2: search must be a string or null'
        using errcode = '22023';
    end if;
    v_search := private.tokenledger_ascii_trim_v2(v_input ->> 'search');
    if v_search = '' then
      v_search := null;
    elsif pg_catalog.octet_length(v_search) > 256 then
      raise exception 'query-v2: search exceeds 256 UTF-8 bytes'
        using errcode = '22023';
    end if;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'range', v_range,
    'timezone', v_timezone,
    'machines', v_machines,
    'tools', v_tools,
    'models', v_models,
    'search', v_search,
    'tokenMode', v_token_mode
  );

  if pg_catalog.jsonb_array_length(v_machines) <= 1 then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'machine', case when pg_catalog.jsonb_array_length(v_machines) = 1 then v_machines ->> 0 else null end
    );
  end if;
  if pg_catalog.jsonb_array_length(v_tools) <= 1 then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'tool', case when pg_catalog.jsonb_array_length(v_tools) = 1 then v_tools ->> 0 else null end
    );
  end if;
  if pg_catalog.jsonb_array_length(v_models) <= 1 then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'model', case when pg_catalog.jsonb_array_length(v_models) = 1 then v_models ->> 0 else null end
    );
  end if;

  return v_result;
end;
$$;

create or replace function private.tokenledger_normalize_entity_v2(
  p_entity jsonb,
  p_query jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_kind text;
  v_id text;
begin
  if p_entity is null or pg_catalog.jsonb_typeof(p_entity) <> 'object' then
    raise exception 'entity-v2: p_entity must be an object'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_entity -> 'kind') <> 'string'
     or pg_catalog.jsonb_typeof(p_entity -> 'id') <> 'string' then
    raise exception 'entity-v2: kind/id must be strings'
      using errcode = '22023';
  end if;

  v_kind := pg_catalog.lower(private.tokenledger_ascii_trim_v2(p_entity ->> 'kind'));
  v_id := private.tokenledger_ascii_trim_v2(p_entity ->> 'id');
  if v_kind not in ('tool', 'model') then
    raise exception 'entity-v2: invalid kind %', v_kind
      using errcode = '22023';
  end if;
  if v_id = '' then
    raise exception 'entity-v2: empty id'
      using errcode = '22023';
  end if;
  if pg_catalog.octet_length(v_id) > 256 then
    raise exception 'entity-v2: id exceeds 256 UTF-8 bytes'
      using errcode = '22023';
  end if;
  if v_kind = 'tool' and pg_catalog.jsonb_array_length(p_query -> 'tools') <> 0 then
    raise exception 'entity-v2: tool entity requires query.tools=[]'
      using errcode = '22023';
  end if;
  if v_kind = 'model' and pg_catalog.jsonb_array_length(p_query -> 'models') <> 0 then
    raise exception 'entity-v2: model entity requires query.models=[]'
      using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('kind', v_kind, 'id', v_id);
end;
$$;

-- Search is a literal substring operation. translate() folds ASCII A-Z only,
-- leaving all non-ASCII code points untouched. strpos gives %, _ and \ no
-- wildcard or escape meaning.
create or replace function private.tokenledger_search_match_v2(
  p_search text,
  p_tool text,
  p_model text,
  p_machine text,
  p_session text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when p_search is null then true
    when pg_catalog.octet_length(p_search) = pg_catalog.char_length(p_search) then
      pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_tool, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        pg_catalog.translate(p_search, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      ) > 0
      or pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_model, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        pg_catalog.translate(p_search, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      ) > 0
      or pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_machine, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        pg_catalog.translate(p_search, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      ) > 0
      or pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_session, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        pg_catalog.translate(p_search, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      ) > 0
    else
      pg_catalog.strpos(coalesce(p_tool, ''), p_search) > 0
      or pg_catalog.strpos(coalesce(p_model, ''), p_search) > 0
      or pg_catalog.strpos(coalesce(p_machine, ''), p_search) > 0
      or pg_catalog.strpos(coalesce(p_session, ''), p_search) > 0
  end;
$$;

create or replace function private.tokenledger_usage_summary_v2(
  p_user uuid,
  p_start text,
  p_end text,
  p_query jsonb,
  p_entity jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text := p_query ->> 'search';
  v_entity_kind text := p_entity ->> 'kind';
  v_entity_id text := p_entity ->> 'id';
  v_result jsonb;
begin
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines from pg_catalog.jsonb_array_elements_text(p_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools from pg_catalog.jsonb_array_elements_text(p_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models from pg_catalog.jsonb_array_elements_text(p_query -> 'models') as e(value);

  with agg as (
    select
      coalesce(pg_catalog.sum(t.input_tokens + t.output_tokens), 0)::bigint as total_tokens,
      coalesce(pg_catalog.sum(t.input_tokens), 0)::bigint as input_tokens,
      coalesce(pg_catalog.sum(t.output_tokens), 0)::bigint as output_tokens,
      coalesce(pg_catalog.sum(t.cached_tokens), 0)::bigint as cached_tokens,
      coalesce(pg_catalog.sum(coalesce(t.cache_write_tokens, 0)), 0)::bigint as cache_write_tokens,
      coalesce(pg_catalog.sum(coalesce(t.cost_usd, 0)), 0)::double precision as cost_usd,
      coalesce(pg_catalog.sum(t.requests), 0)::bigint as requests
    from public.token_logs t
    where t.user_id = p_user
      and (p_start is null or t.timestamp >= p_start)
      and (p_end is null or t.timestamp <= p_end)
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and (p_entity is null or (v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
  )
  select pg_catalog.jsonb_build_object(
    'totalTokens', a.total_tokens,
    'inputTokens', a.input_tokens,
    'outputTokens', a.output_tokens,
    'cachedTokens', a.cached_tokens,
    'cacheReadTokens', greatest(a.cached_tokens - a.cache_write_tokens, 0),
    'cacheWriteTokens', a.cache_write_tokens,
    'totalCost', a.cost_usd,
    'totalRequests', a.requests,
    'avgTokensPerReq', case when a.requests > 0
      then pg_catalog.round(a.total_tokens::numeric / a.requests, 0)::bigint else 0 end
  ) into v_result
  from agg a;

  return v_result;
end;
$$;

create or replace function private.tokenledger_usage_series_v2(
  p_user uuid,
  p_start timestamp,
  p_end timestamp,
  p_bucket text,
  p_query jsonb,
  p_entity jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text := p_query ->> 'search';
  v_entity_kind text := p_entity ->> 'kind';
  v_entity_id text := p_entity ->> 'id';
  v_result jsonb;
begin
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines from pg_catalog.jsonb_array_elements_text(p_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools from pg_catalog.jsonb_array_elements_text(p_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models from pg_catalog.jsonb_array_elements_text(p_query -> 'models') as e(value);

  with slots as (
    select
      g as bucket_index,
      case p_bucket when 'hour' then pg_catalog.lpad(g::text, 2, '0') || ':00'
        else 'D' || pg_catalog.lpad((g + 1)::text, 2, '0') end as bucket
    from pg_catalog.generate_series(
      0,
      case p_bucket when 'hour' then greatest(0, least(23, extract(hour from p_end)::integer))
        else greatest(0, p_end::date - p_start::date) end
    ) g
  ), aggregated as (
    select
      case p_bucket
        when 'hour' then case when t.timestamp ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
          then pg_catalog.substr(t.timestamp, 12, 2)::integer else null end
        else public.immutable_date_parse(t.timestamp) - p_start::date
      end as bucket_index,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      pg_catalog.sum(t.requests)::bigint as requests,
      pg_catalog.sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and t.timestamp >= pg_catalog.to_char(p_start, 'YYYY-MM-DD HH24:MI:SS')
      and t.timestamp <= pg_catalog.to_char(p_end, 'YYYY-MM-DD HH24:MI:SS')
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and (p_entity is null or (v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
    group by 1
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'bucket', s.bucket,
        'tokens', coalesce(a.tokens, 0),
        'requests', coalesce(a.requests, 0),
        'cost', coalesce(a.cost, 0)
      ) order by s.bucket_index
    ),
    '[]'::jsonb
  ) into v_result
  from slots s left join aggregated a using (bucket_index);

  return v_result;
end;
$$;

create or replace function private.tokenledger_usage_details_core_v2(
  p_user uuid,
  p_query jsonb,
  p_entity jsonb default null,
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
  v_range text := p_query ->> 'range';
  v_timezone text := p_query ->> 'timezone';
  v_now timestamp := pg_catalog.now() at time zone (p_query ->> 'timezone');
  v_start timestamp;
  v_end timestamp;
  v_start_text text;
  v_end_text text;
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text := p_query ->> 'search';
  v_entity_kind text := p_entity ->> 'kind';
  v_entity_id text := p_entity ->> 'id';
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_fingerprint text := pg_catalog.md5(p_query::text || E'\n' || coalesce(p_entity::text, ''));
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
  v_tools_facet jsonb;
  v_models_facet jsonb;
  v_machines_facet jsonb;
  v_meta jsonb;
begin
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines from pg_catalog.jsonb_array_elements_text(p_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools from pg_catalog.jsonb_array_elements_text(p_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models from pg_catalog.jsonb_array_elements_text(p_query -> 'models') as e(value);

  v_end := v_now;
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
  v_end_text := pg_catalog.to_char(v_end, 'YYYY-MM-DD HH24:MI:SS');

  if p_cursor is not null and p_cursor <> '' then
    begin
      v_cursor_parts := pg_catalog.string_to_array(p_cursor, '.');
      if pg_catalog.array_length(v_cursor_parts, 1) <> 4 or v_cursor_parts[1] <> 'v2' then
        raise exception 'invalid cursor';
      end if;
      v_cursor_timestamp := pg_catalog.convert_from(pg_catalog.decode(v_cursor_parts[2], 'hex'), 'UTF8');
      v_cursor_id := v_cursor_parts[3]::bigint;
      if v_cursor_parts[4] <> v_fingerprint then
        raise exception 'query fingerprint mismatch';
      end if;
      if v_cursor_timestamp !~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
         or v_cursor_id < 0 then
        raise exception 'invalid cursor payload';
      end if;
    exception when others then
      raise exception 'get_usage_details_v2: invalid or query-bound cursor'
        using errcode = '22023';
    end;
  end if;

  select pg_catalog.count(*)::bigint
  into v_total_count
  from public.token_logs t
  where t.user_id = p_user
    and (v_start_text is null or t.timestamp >= v_start_text)
    and t.timestamp <= v_end_text
    and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
    and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
    and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
    and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
    and (p_entity is null or (v_entity_kind = 'tool' and t.tool = v_entity_id)
         or (v_entity_kind = 'model' and t.model = v_entity_id));

  v_summary := private.tokenledger_usage_summary_v2(
    p_user, v_start_text, v_end_text, p_query, p_entity
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
      pg_catalog.row_number() over (order by t.timestamp desc, t.id desc) as row_number
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and (p_entity is null or (v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
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
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
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
        ) order by c.timestamp desc, c.id desc
      ) filter (where c.row_number <= v_limit),
      '[]'::jsonb
    ),
    pg_catalog.count(*) > v_limit,
    pg_catalog.max(c.timestamp) filter (where c.row_number = v_limit),
    pg_catalog.max(c.id) filter (where c.row_number = v_limit)
  into v_items, v_has_more, v_last_timestamp, v_last_id
  from candidates c;

  if v_has_more and v_last_timestamp is not null and v_last_id is not null then
    v_next_cursor := 'v2.'
      || pg_catalog.encode(pg_catalog.convert_to(v_last_timestamp, 'UTF8'), 'hex')
      || '.' || v_last_id::text || '.' || v_fingerprint;
  end if;

  -- Facets remove only their own query dimension. Entity selectors remain
  -- applied because they are a separate, immutable part of request identity.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('value', f.value, 'count', f.count)
      order by f.count desc, pg_catalog.convert_to(f.value, 'UTF8')
    ), '[]'::jsonb
  ) into v_tools_facet
  from (
    select t.tool as value, pg_catalog.count(*)::bigint as count
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and (p_entity is null or (v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
    group by t.tool
  ) f;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('value', f.value, 'count', f.count)
      order by f.count desc, pg_catalog.convert_to(f.value, 'UTF8')
    ), '[]'::jsonb
  ) into v_models_facet
  from (
    select t.model as value, pg_catalog.count(*)::bigint as count
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and (p_entity is null or (v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
    group by t.model
  ) f;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('value', f.value, 'count', f.count)
      order by f.count desc, pg_catalog.convert_to(f.value, 'UTF8')
    ), '[]'::jsonb
  ) into v_machines_facet
  from (
    select t.machine_id as value, pg_catalog.count(*)::bigint as count
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and (p_entity is null or (v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
      and t.machine_id <> ''
    group by t.machine_id
  ) f;

  v_meta := pg_catalog.jsonb_build_object(
    'contractVersion', 2,
    'generatedAt', pg_catalog.now(),
    'timezone', v_timezone,
    'query', p_query,
    'cursorFingerprint', v_fingerprint,
    'capabilities', pg_catalog.jsonb_build_object(
      'detailPagination', true,
      'multiFilterSearch', true
    )
  );
  if p_entity is not null then
    v_meta := v_meta || pg_catalog.jsonb_build_object('entity', p_entity);
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'nextCursor', v_next_cursor,
    'hasMore', v_has_more,
    'totalCount', v_total_count,
    'filteredSummary', v_summary,
    'availableFilters', pg_catalog.jsonb_build_object(
      'tools', v_tools_facet,
      'models', v_models_facet,
      'machines', v_machines_facet
    ),
    'granularity', 'hour',
    'meta', v_meta
  );
end;
$$;

create or replace function public.get_usage_details_v2(
  p_user uuid,
  p_query jsonb,
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
  v_query jsonb;
begin
  if p_user is null or (select auth.uid()) is distinct from p_user then
    raise exception 'get_usage_details_v2: user mismatch'
      using errcode = '42501';
  end if;
  v_query := private.tokenledger_normalize_query_v2(p_query);
  return private.tokenledger_usage_details_core_v2(
    p_user, v_query, null, p_cursor, p_limit
  );
end;
$$;

create or replace function private.tokenledger_usage_comparison_core_v2(
  p_user uuid,
  p_query jsonb,
  p_entity jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_range text := p_query ->> 'range';
  v_timezone text := p_query ->> 'timezone';
  v_now timestamp := pg_catalog.now() at time zone (p_query ->> 'timezone');
  v_current_start timestamp;
  v_current_end timestamp;
  v_previous_start timestamp;
  v_previous_end timestamp;
  v_previous_last_day integer;
  v_common_day integer;
  v_bucket text;
  v_kind text;
  v_aligned_through text;
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
  v_meta jsonb;
begin
  if v_range not in ('today', 'week', 'month') then
    return null;
  end if;

  case v_range
    when 'today' then
      v_kind := 'dayOverDay';
      v_bucket := 'hour';
      v_current_start := pg_catalog.date_trunc('day', v_now);
      v_current_end := v_now;
      v_previous_start := v_current_start - interval '1 day';
      v_previous_end := v_current_end - interval '1 day';
      v_aligned_through := pg_catalog.to_char(v_current_end, 'HH24:MI');
    when 'week' then
      v_kind := 'weekOverWeek';
      v_bucket := 'day';
      v_current_start := pg_catalog.date_trunc('week', v_now);
      v_current_end := v_now;
      v_previous_start := v_current_start - interval '7 days';
      v_previous_end := v_current_end - interval '7 days';
      v_aligned_through := 'D' || (v_current_end::date - v_current_start::date + 1)::text
        || ' ' || pg_catalog.to_char(v_current_end, 'HH24:MI');
    when 'month' then
      v_kind := 'monthOverMonth';
      v_bucket := 'day';
      v_current_start := pg_catalog.date_trunc('month', v_now);
      v_previous_start := v_current_start - interval '1 month';
      v_previous_last_day := extract(day from (v_current_start - interval '1 day'))::integer;
      v_common_day := least(extract(day from v_now)::integer, v_previous_last_day);
      v_current_end := v_current_start
        + pg_catalog.make_interval(days => v_common_day - 1)
        + (v_now - pg_catalog.date_trunc('day', v_now));
      v_previous_end := v_previous_start
        + pg_catalog.make_interval(days => v_common_day - 1)
        + (v_now - pg_catalog.date_trunc('day', v_now));
      v_aligned_through := 'D' || v_common_day::text || ' '
        || pg_catalog.to_char(v_current_end, 'HH24:MI');
  end case;

  v_current_summary := private.tokenledger_usage_summary_v2(
    p_user,
    pg_catalog.to_char(v_current_start, 'YYYY-MM-DD HH24:MI:SS'),
    pg_catalog.to_char(v_current_end, 'YYYY-MM-DD HH24:MI:SS'),
    p_query,
    p_entity
  );
  v_previous_summary := private.tokenledger_usage_summary_v2(
    p_user,
    pg_catalog.to_char(v_previous_start, 'YYYY-MM-DD HH24:MI:SS'),
    pg_catalog.to_char(v_previous_end, 'YYYY-MM-DD HH24:MI:SS'),
    p_query,
    p_entity
  );
  v_current_series := private.tokenledger_usage_series_v2(
    p_user, v_current_start, v_current_end, v_bucket, p_query, p_entity
  );
  v_previous_series := private.tokenledger_usage_series_v2(
    p_user, v_previous_start, v_previous_end, v_bucket, p_query, p_entity
  );

  v_current_tokens := coalesce((v_current_summary ->> 'totalTokens')::numeric, 0);
  v_previous_tokens := coalesce((v_previous_summary ->> 'totalTokens')::numeric, 0);
  v_current_requests := coalesce((v_current_summary ->> 'totalRequests')::numeric, 0);
  v_previous_requests := coalesce((v_previous_summary ->> 'totalRequests')::numeric, 0);
  v_current_cost := coalesce((v_current_summary ->> 'totalCost')::numeric, 0);
  v_previous_cost := coalesce((v_previous_summary ->> 'totalCost')::numeric, 0);

  v_meta := pg_catalog.jsonb_build_object(
    'contractVersion', 2,
    'generatedAt', pg_catalog.now(),
    'query', p_query,
    'capabilities', pg_catalog.jsonb_build_object(
      'comparison', true,
      'multiFilterSearch', true
    )
  );
  if p_entity is not null then
    v_meta := v_meta || pg_catalog.jsonb_build_object('entity', p_entity);
  end if;

  return pg_catalog.jsonb_build_object(
    'window', pg_catalog.jsonb_build_object(
      'kind', v_kind,
      'timezone', v_timezone,
      'bucket', v_bucket,
      'currentStart', pg_catalog.timezone(v_timezone, v_current_start),
      'currentEnd', pg_catalog.timezone(v_timezone, v_current_end),
      'previousStart', pg_catalog.timezone(v_timezone, v_previous_start),
      'previousEnd', pg_catalog.timezone(v_timezone, v_previous_end),
      'alignedThrough', v_aligned_through
    ),
    'current', pg_catalog.jsonb_build_object(
      'summary', v_current_summary,
      'series', v_current_series
    ),
    'previous', pg_catalog.jsonb_build_object(
      'summary', v_previous_summary,
      'series', v_previous_series
    ),
    'delta', pg_catalog.jsonb_build_object(
      'tokens', pg_catalog.jsonb_build_object(
        'absolute', v_current_tokens - v_previous_tokens,
        'percent', case when v_previous_tokens > 0
          then pg_catalog.round((v_current_tokens - v_previous_tokens) * 100 / v_previous_tokens, 2)
          else null end,
        'direction', case
          when v_current_tokens = 0 and v_previous_tokens = 0 then 'flat'
          when v_previous_tokens = 0 and v_current_tokens > 0 then 'new'
          when v_current_tokens > v_previous_tokens then 'up'
          when v_current_tokens < v_previous_tokens then 'down'
          else 'flat' end
      ),
      'requests', pg_catalog.jsonb_build_object(
        'absolute', v_current_requests - v_previous_requests,
        'percent', case when v_previous_requests > 0
          then pg_catalog.round((v_current_requests - v_previous_requests) * 100 / v_previous_requests, 2)
          else null end,
        'direction', case
          when v_current_requests = 0 and v_previous_requests = 0 then 'flat'
          when v_previous_requests = 0 and v_current_requests > 0 then 'new'
          when v_current_requests > v_previous_requests then 'up'
          when v_current_requests < v_previous_requests then 'down'
          else 'flat' end
      ),
      'cost', pg_catalog.jsonb_build_object(
        'absolute', v_current_cost - v_previous_cost,
        'percent', case when v_previous_cost > 0
          then pg_catalog.round((v_current_cost - v_previous_cost) * 100 / v_previous_cost, 2)
          else null end,
        'direction', case
          when v_current_cost = 0 and v_previous_cost = 0 then 'flat'
          when v_previous_cost = 0 and v_current_cost > 0 then 'new'
          when v_current_cost > v_previous_cost then 'up'
          when v_current_cost < v_previous_cost then 'down'
          else 'flat' end
      )
    ),
    'meta', v_meta
  );
end;
$$;

create or replace function public.get_usage_comparison_v2(
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
begin
  if p_user is null or (select auth.uid()) is distinct from p_user then
    raise exception 'get_usage_comparison_v2: user mismatch'
      using errcode = '42501';
  end if;
  v_query := private.tokenledger_normalize_query_v2(p_query);
  return private.tokenledger_usage_comparison_core_v2(p_user, v_query, null);
end;
$$;

create or replace function public.get_usage_entity_dashboard_v2(
  p_user uuid,
  p_query jsonb,
  p_entity jsonb,
  p_cursor text default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query jsonb;
  v_entity jsonb;
  v_range text;
  v_timezone text;
  v_now timestamp;
  v_start timestamp;
  v_end timestamp;
  v_start_text text;
  v_end_text text;
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text;
  v_entity_kind text;
  v_entity_id text;
  v_summary jsonb;
  v_comparison jsonb;
  v_by_tools jsonb;
  v_by_models jsonb;
  v_by_machines jsonb;
  v_heatmap jsonb;
  v_peak jsonb;
  v_activity jsonb;
  v_history_page jsonb;
  v_meta jsonb;
begin
  if p_user is null or (select auth.uid()) is distinct from p_user then
    raise exception 'get_usage_entity_dashboard_v2: user mismatch'
      using errcode = '42501';
  end if;

  v_query := private.tokenledger_normalize_query_v2(p_query);
  v_entity := private.tokenledger_normalize_entity_v2(p_entity, v_query);
  v_range := v_query ->> 'range';
  v_timezone := v_query ->> 'timezone';
  v_now := pg_catalog.now() at time zone v_timezone;
  v_end := v_now;
  v_search := v_query ->> 'search';
  v_entity_kind := v_entity ->> 'kind';
  v_entity_id := v_entity ->> 'id';

  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines from pg_catalog.jsonb_array_elements_text(v_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools from pg_catalog.jsonb_array_elements_text(v_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models from pg_catalog.jsonb_array_elements_text(v_query -> 'models') as e(value);

  case v_range
    when 'today' then v_start := pg_catalog.date_trunc('day', v_now);
    when 'week' then v_start := pg_catalog.date_trunc('week', v_now);
    when 'month' then v_start := pg_catalog.date_trunc('month', v_now);
    when 'year' then v_start := pg_catalog.date_trunc('year', v_now);
    when 'all' then v_start := null;
  end case;
  v_start_text := case when v_start is null then null
    else pg_catalog.to_char(v_start, 'YYYY-MM-DD HH24:MI:SS') end;
  v_end_text := pg_catalog.to_char(v_end, 'YYYY-MM-DD HH24:MI:SS');

  v_summary := private.tokenledger_usage_summary_v2(
    p_user, v_start_text, v_end_text, v_query, v_entity
  );
  v_comparison := private.tokenledger_usage_comparison_core_v2(
    p_user, v_query, v_entity
  );

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
      ) order by d.tokens desc, pg_catalog.convert_to(d.value, 'UTF8')
    ), '[]'::jsonb
  ) into v_by_tools
  from (
    select
      t.tool as value,
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
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and ((v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
    group by t.tool
  ) d;

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
      ) order by d.tokens desc, pg_catalog.convert_to(d.value, 'UTF8')
    ), '[]'::jsonb
  ) into v_by_models
  from (
    select
      t.model as value,
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
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and ((v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
    group by t.model
  ) d;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'value', d.value,
        'tokens', d.tokens,
        'requests', d.requests,
        'cost', d.cost
      ) order by d.tokens desc, pg_catalog.convert_to(d.value, 'UTF8')
    ), '[]'::jsonb
  ) into v_by_machines
  from (
    select
      t.machine_id as value,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      pg_catalog.sum(t.requests)::bigint as requests,
      pg_catalog.sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and ((v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
      and t.machine_id <> ''
    group by t.machine_id
  ) d;

  select coalesce(
    pg_catalog.jsonb_object_agg(h.date, h.tokens order by h.date),
    '{}'::jsonb
  ) into v_heatmap
  from (
    select
      public.immutable_date_parse(t.timestamp)::text as date,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens
    from public.token_logs t
    where t.user_id = p_user
      and public.immutable_date_parse(t.timestamp) >= pg_catalog.date_trunc('year', v_now)::date
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and ((v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
    group by 1
  ) h;

  select coalesce(
    pg_catalog.jsonb_build_object(
      'bucket', p.bucket,
      'tokens', p.tokens,
      'requests', p.requests,
      'cost', p.cost
    ), '{}'::jsonb
  ) into v_peak
  from (
    select
      case when v_range = 'today' then pg_catalog.substr(t.timestamp, 12, 2) || ':00'
        else public.immutable_date_parse(t.timestamp)::text end as bucket,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      pg_catalog.sum(t.requests)::bigint as requests,
      pg_catalog.sum(coalesce(t.cost_usd, 0))::double precision as cost
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
      and ((v_entity_kind = 'tool' and t.tool = v_entity_id)
           or (v_entity_kind = 'model' and t.model = v_entity_id))
      and t.timestamp ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
    group by 1
    order by tokens desc, bucket
    limit 1
  ) p;
  v_peak := coalesce(v_peak, '{}'::jsonb);

  select pg_catalog.jsonb_build_object(
    'activeDays', pg_catalog.count(distinct public.immutable_date_parse(t.timestamp)),
    'firstSeenAt', pg_catalog.min(t.timestamp),
    'lastSeenAt', pg_catalog.max(t.timestamp)
  ) into v_activity
  from public.token_logs t
  where t.user_id = p_user
    and (v_start_text is null or t.timestamp >= v_start_text)
    and t.timestamp <= v_end_text
    and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
    and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
    and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
    and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
    and ((v_entity_kind = 'tool' and t.tool = v_entity_id)
         or (v_entity_kind = 'model' and t.model = v_entity_id));

  v_history_page := private.tokenledger_usage_details_core_v2(
    p_user, v_query, v_entity, p_cursor, p_limit
  );
  v_meta := pg_catalog.jsonb_build_object(
    'contractVersion', 2,
    'generatedAt', pg_catalog.now(),
    'timezone', v_timezone,
    'query', v_query,
    'entity', v_entity,
    'capabilities', pg_catalog.jsonb_build_object(
      'comparison', true,
      'detailPagination', true,
      'entityDashboard', true,
      'multiFilterSearch', true
    )
  );

  return pg_catalog.jsonb_build_object(
    'entity', v_entity || pg_catalog.jsonb_build_object(
      'tool', case when v_entity_kind = 'tool' then v_entity_id else null end,
      'model', case when v_entity_kind = 'model' then v_entity_id else null end
    ),
    'summary', v_summary,
    'comparison', v_comparison,
    'composition', pg_catalog.jsonb_build_object(
      'tools', v_by_tools,
      'models', v_by_models,
      'machines', v_by_machines
    ),
    'heatmap', v_heatmap,
    'peak', v_peak,
    'activity', v_activity,
    'historyPage', v_history_page,
    'granularity', 'hour',
    'meta', v_meta
  );
end;
$$;

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
  v_trend_bucket text;
  v_machines text[];
  v_tools text[];
  v_models text[];
  v_search text;
  v_summary jsonb;
  v_tools_data jsonb;
  v_models_data jsonb;
  v_trends jsonb;
  v_heatmap jsonb;
  v_history_page jsonb;
  v_machine_list jsonb;
  v_comparison jsonb;
  v_dirty_generation bigint;
  v_refreshed_generation bigint;
  v_last_refreshed_at timestamptz;
  v_meta jsonb;
begin
  if p_user is null or (select auth.uid()) is distinct from p_user then
    raise exception 'get_dashboard_stats_v2: user mismatch'
      using errcode = '42501';
  end if;

  v_query := private.tokenledger_normalize_query_v2(p_query);
  v_range := v_query ->> 'range';
  v_timezone := v_query ->> 'timezone';
  v_now := pg_catalog.now() at time zone v_timezone;
  v_search := v_query ->> 'search';

  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines from pg_catalog.jsonb_array_elements_text(v_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools from pg_catalog.jsonb_array_elements_text(v_query -> 'tools') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_models from pg_catalog.jsonb_array_elements_text(v_query -> 'models') as e(value);

  case v_range
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
  v_end_text := pg_catalog.to_char(v_now, 'YYYY-MM-DD HH24:MI:SS');

  v_summary := private.tokenledger_usage_summary_v2(
    p_user, v_start_text, v_end_text, v_query, null
  );

  select coalesce(
    pg_catalog.jsonb_object_agg(
      d.tool,
      pg_catalog.jsonb_build_object(
        'name', d.tool,
        'input', d.input_tokens,
        'output', d.output_tokens,
        'cached', d.cached_tokens,
        'cacheRead', greatest(d.cached_tokens - d.cache_write_tokens, 0),
        'cacheWrite', d.cache_write_tokens,
        'total', d.total_tokens,
        'cost', d.cost_usd,
        'requests', d.requests,
        'heatmap', d.heatmap,
        'models', d.models
      )
    ), '{}'::jsonb
  ) into v_tools_data
  from (
    select
      t.tool,
      pg_catalog.sum(t.input_tokens)::bigint as input_tokens,
      pg_catalog.sum(t.output_tokens)::bigint as output_tokens,
      pg_catalog.sum(t.cached_tokens)::bigint as cached_tokens,
      pg_catalog.sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as total_tokens,
      pg_catalog.sum(coalesce(t.cost_usd, 0))::double precision as cost_usd,
      pg_catalog.sum(t.requests)::bigint as requests,
      (
        select coalesce(
          pg_catalog.jsonb_object_agg(h.date, h.tokens order by h.date), '{}'::jsonb
        )
        from (
          select public.immutable_date_parse(t2.timestamp)::text as date,
            pg_catalog.sum(t2.input_tokens + t2.output_tokens)::bigint as tokens
          from public.token_logs t2
          where t2.user_id = p_user
            and t2.tool = t.tool
            and (v_start_text is null or t2.timestamp >= v_start_text)
            and t2.timestamp <= v_end_text
            and (pg_catalog.cardinality(v_machines) = 0 or t2.machine_id = any(v_machines))
            and (pg_catalog.cardinality(v_models) = 0 or t2.model = any(v_models))
            and private.tokenledger_search_match_v2(v_search, t2.tool, t2.model, t2.machine_id, t2.session_id)
          group by 1
        ) h
      ) as heatmap,
      (
        select coalesce(
          pg_catalog.jsonb_object_agg(m.model, m.tokens), '{}'::jsonb
        )
        from (
          select t3.model,
            pg_catalog.sum(t3.input_tokens + t3.output_tokens)::bigint as tokens
          from public.token_logs t3
          where t3.user_id = p_user
            and t3.tool = t.tool
            and (v_start_text is null or t3.timestamp >= v_start_text)
            and t3.timestamp <= v_end_text
            and (pg_catalog.cardinality(v_machines) = 0 or t3.machine_id = any(v_machines))
            and (pg_catalog.cardinality(v_models) = 0 or t3.model = any(v_models))
            and private.tokenledger_search_match_v2(v_search, t3.tool, t3.model, t3.machine_id, t3.session_id)
          group by t3.model
        ) m
      ) as models
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
    group by t.tool
  ) d;

  select coalesce(
    pg_catalog.jsonb_object_agg(
      d.model,
      pg_catalog.jsonb_build_object(
        'name', d.model,
        'total', d.total_tokens,
        'requests', d.requests,
        'input', d.input_tokens,
        'output', d.output_tokens,
        'cached', d.cached_tokens,
        'cacheWrite', d.cache_write_tokens,
        'cost', d.cost_usd,
        'tool', d.tool,
        'heatmap', d.heatmap
      )
    ), '{}'::jsonb
  ) into v_models_data
  from (
    select
      t.model,
      pg_catalog.max(t.tool) as tool,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as total_tokens,
      pg_catalog.sum(t.input_tokens)::bigint as input_tokens,
      pg_catalog.sum(t.output_tokens)::bigint as output_tokens,
      pg_catalog.sum(t.cached_tokens)::bigint as cached_tokens,
      pg_catalog.sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens,
      pg_catalog.sum(coalesce(t.cost_usd, 0))::double precision as cost_usd,
      pg_catalog.sum(t.requests)::bigint as requests,
      (
        select coalesce(
          pg_catalog.jsonb_object_agg(h.date, h.tokens order by h.date), '{}'::jsonb
        )
        from (
          select public.immutable_date_parse(t2.timestamp)::text as date,
            pg_catalog.sum(t2.input_tokens + t2.output_tokens)::bigint as tokens
          from public.token_logs t2
          where t2.user_id = p_user
            and t2.model = t.model
            and (v_start_text is null or t2.timestamp >= v_start_text)
            and t2.timestamp <= v_end_text
            and (pg_catalog.cardinality(v_machines) = 0 or t2.machine_id = any(v_machines))
            and (pg_catalog.cardinality(v_tools) = 0 or t2.tool = any(v_tools))
            and private.tokenledger_search_match_v2(v_search, t2.tool, t2.model, t2.machine_id, t2.session_id)
          group by 1
        ) h
      ) as heatmap
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
    group by t.model
  ) d;

  with bucketed as (
    select
      case v_trend_bucket
        when 'hour' then pg_catalog.lpad(pg_catalog.substr(t.timestamp, 12, 2), 2, '0') || ':00'
        when 'month' then pg_catalog.to_char(public.immutable_date_parse(t.timestamp), 'YYYY-MM')
        else pg_catalog.substr(t.timestamp, 1, 10)
      end as date,
      t.tool,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      pg_catalog.sum(t.requests)::bigint as requests
    from public.token_logs t
    where t.user_id = p_user
      and (v_start_text is null or t.timestamp >= v_start_text)
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
    group by 1, 2
  ), by_date as (
    select date,
      pg_catalog.jsonb_object_agg(tool, tokens) as points,
      pg_catalog.sum(requests)::bigint as requests
    from bucketed
    group by date
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('date', date, '__requests', requests) || points
      order by date
    ), '[]'::jsonb
  ) into v_trends
  from by_date;

  select coalesce(
    pg_catalog.jsonb_object_agg(h.date, h.tokens order by h.date), '{}'::jsonb
  ) into v_heatmap
  from (
    select public.immutable_date_parse(t.timestamp)::text as date,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens
    from public.token_logs t
    where t.user_id = p_user
      and public.immutable_date_parse(t.timestamp) >= pg_catalog.date_trunc('year', v_now)::date
      and t.timestamp <= v_end_text
      and (pg_catalog.cardinality(v_machines) = 0 or t.machine_id = any(v_machines))
      and (pg_catalog.cardinality(v_tools) = 0 or t.tool = any(v_tools))
      and (pg_catalog.cardinality(v_models) = 0 or t.model = any(v_models))
      and private.tokenledger_search_match_v2(v_search, t.tool, t.model, t.machine_id, t.session_id)
    group by 1
  ) h;

  v_history_page := private.tokenledger_usage_details_core_v2(
    p_user, v_query, null, null, 100
  );
  select coalesce(
    pg_catalog.jsonb_agg(e.value ->> 'value' order by e.ordinality), '[]'::jsonb
  ) into v_machine_list
  from pg_catalog.jsonb_array_elements(
    v_history_page #> '{availableFilters,machines}'
  ) with ordinality as e(value, ordinality);
  v_comparison := private.tokenledger_usage_comparison_core_v2(
    p_user, v_query, null
  );

  select dirty_generation, refreshed_generation, last_refreshed_at
    into v_dirty_generation, v_refreshed_generation, v_last_refreshed_at
  from public.sync_state where id = 1;

  v_meta := pg_catalog.jsonb_build_object(
    'contractVersion', 2,
    'generatedAt', pg_catalog.now(),
    'lastRefreshedAt', v_last_refreshed_at,
    'timezone', v_timezone,
    'range', v_range,
    'machine', v_query ->> 'machine',
    'stale', coalesce(v_dirty_generation > v_refreshed_generation, true),
    'query', v_query,
    'capabilities', pg_catalog.jsonb_build_object(
      'comparison', true,
      'detailPagination', true,
      'entityDashboard', true,
      'multiFilterSearch', true,
      'quotaSnapshots', false
    )
  );

  return pg_catalog.jsonb_build_object(
    'summary', v_summary,
    'tools', v_tools_data,
    'models', v_models_data,
    'trends', v_trends,
    'comparison', v_comparison,
    'heatmap', v_heatmap,
    'history', v_history_page -> 'items',
    'historyPage', v_history_page,
    'machines', v_machine_list,
    'meta', v_meta
  );
end;
$$;

revoke execute on function private.tokenledger_ascii_trim_v2(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_normalize_array_v2(jsonb, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_normalize_singular_v2(jsonb, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_normalize_query_v2(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_normalize_entity_v2(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_search_match_v2(text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_usage_summary_v2(uuid, text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_usage_series_v2(uuid, timestamp, timestamp, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_usage_details_core_v2(uuid, jsonb, jsonb, text, integer)
  from public, anon, authenticated, service_role;
revoke execute on function private.tokenledger_usage_comparison_core_v2(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

revoke execute on function public.get_dashboard_stats_v2(uuid, jsonb)
  from public, anon;
revoke execute on function public.get_usage_comparison_v2(uuid, jsonb)
  from public, anon;
revoke execute on function public.get_usage_details_v2(uuid, jsonb, text, integer)
  from public, anon;
revoke execute on function public.get_usage_entity_dashboard_v2(uuid, jsonb, jsonb, text, integer)
  from public, anon;

grant execute on function public.get_dashboard_stats_v2(uuid, jsonb)
  to authenticated, service_role;
grant execute on function public.get_usage_comparison_v2(uuid, jsonb)
  to authenticated, service_role;
grant execute on function public.get_usage_details_v2(uuid, jsonb, text, integer)
  to authenticated, service_role;
grant execute on function public.get_usage_entity_dashboard_v2(uuid, jsonb, jsonb, text, integer)
  to authenticated, service_role;

comment on function public.get_dashboard_stats_v2(uuid, jsonb)
  is 'TokenLedger canonical multi-filter/search dashboard stats v2.';
comment on function public.get_usage_comparison_v2(uuid, jsonb)
  is 'TokenLedger canonical multi-filter/search equal-progress comparison v2.';
comment on function public.get_usage_details_v2(uuid, jsonb, text, integer)
  is 'TokenLedger canonical multi-filter/search keyset details v2 with query-bound cursor.';
comment on function public.get_usage_entity_dashboard_v2(uuid, jsonb, jsonb, text, integer)
  is 'TokenLedger canonical entity dashboard v2 with query/entity-bound history cursor.';
