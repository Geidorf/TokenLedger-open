-- T10.88: preserve the provenance that Stats v2 can express without changing
-- its contract version. Required cost fields retain the established numeric
-- behavior. Only the optional main-dashboard models.*.cost field is removed
-- when its contributing costs are not all finite, non-negative, and safely
-- representable as one double precision value.

-- Historical migrations backfilled missing cache writes to zero. Future rows
-- must keep SQL NULL when a producer does not supply this provenance.
alter table public.token_logs
  alter column cache_write_tokens drop not null,
  alter column cache_write_tokens drop default;

-- The existing private dashboard base sums model cost as float8 before the
-- public wrapper can remove an unsafe value. Replace only that second, model
-- aggregate with numeric accumulation. The guarded rewrite deliberately fails
-- migration replay if the frozen migration head no longer has the expected
-- two tool/model aggregate expressions.
do $migration$
declare
  v_definition text;
  v_needle constant text :=
    'pg_catalog.sum(coalesce(t.cost_usd, 0))::double precision as cost_usd,';
  -- Keep every established required cost aggregate in the frozen v2 base
  -- untouched. The second match is only models.*.cost, which is optional in
  -- the public dashboard response. Numeric accumulation prevents float8 sum
  -- overflow; SQL NULL is later encoded as an omitted JSON key.
  v_replacement constant text := $replacement$case
        when pg_catalog.bool_and(
          t.cost_usd is not null
          and t.cost_usd >= 0::double precision
          and t.cost_usd < 'Infinity'::double precision
        )
        and pg_catalog.sum(
          case
            when t.cost_usd is not null
              and t.cost_usd >= 0::double precision
              and t.cost_usd < 'Infinity'::double precision
              then t.cost_usd::numeric
            else 0::numeric
          end
        ) <= 1.7976931348623157e308::numeric
          then pg_catalog.sum(
            case
              when t.cost_usd is not null
                and t.cost_usd >= 0::double precision
                and t.cost_usd < 'Infinity'::double precision
                then t.cost_usd::numeric
              else 0::numeric
            end
          )::double precision
        else null::double precision
      end as cost_usd,$replacement$;
  v_first integer;
  v_second_relative integer;
  v_second integer;
begin
  select pg_catalog.pg_get_functiondef(
    'private.get_dashboard_stats_v2_base_t63(uuid,jsonb)'::pg_catalog.regprocedure
  ) into v_definition;

  v_first := pg_catalog.strpos(v_definition, v_needle);
  if v_first = 0 then
    raise exception 'T10.88 expected dashboard tool cost aggregate was not found';
  end if;

  v_second_relative := pg_catalog.strpos(
    pg_catalog.substr(v_definition, v_first + pg_catalog.length(v_needle)),
    v_needle
  );
  if v_second_relative = 0 then
    raise exception 'T10.88 expected dashboard model cost aggregate was not found';
  end if;
  v_second := v_first + pg_catalog.length(v_needle) + v_second_relative - 1;

  if pg_catalog.strpos(
    pg_catalog.substr(v_definition, v_second + pg_catalog.length(v_needle)),
    v_needle
  ) > 0 then
    raise exception 'T10.88 dashboard cost aggregate shape is ambiguous';
  end if;

  v_definition := pg_catalog.substr(v_definition, 1, v_second - 1)
    || v_replacement
    || pg_catalog.substr(
      v_definition,
      v_second + pg_catalog.length(v_needle)
    );
  execute v_definition;
end;
$migration$;

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
  v_summary_provenance jsonb;
  v_tool_provenance jsonb;
  v_model_provenance jsonb;
  v_machine_provenance jsonb;
  v_response jsonb;
  v_entry record;
  v_item jsonb;
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

  -- One filtered scan supplies every cache-split decision. A historical
  -- cached>0/write=0 row is not evidence of a zero write because earlier
  -- migrations backfilled that zero. Required dashboard values, including
  -- all non-model cost fields and machineDistribution, stay in the frozen
  -- v2 base response and are never recomputed here.
  with filtered as materialized (
    select
      t.tool,
      t.model,
      t.machine_id,
      t.cached_tokens,
      t.cache_write_tokens
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
  ), aggregated as (
    select
      case
        when grouping(f.tool) = 0 then 'tool'
        when grouping(f.model) = 0 then 'model'
        when grouping(f.machine_id) = 0 then 'machine'
        else 'summary'
      end as kind,
      case
        when grouping(f.tool) = 0 then f.tool
        when grouping(f.model) = 0 then f.model
        when grouping(f.machine_id) = 0 then f.machine_id
        else null
      end as group_key,
      pg_catalog.count(*)::bigint as row_count,
      pg_catalog.sum(f.cached_tokens)::bigint as cached_tokens,
      pg_catalog.sum(coalesce(f.cache_write_tokens, 0))::bigint as cache_write_tokens,
      pg_catalog.bool_and(
        f.cached_tokens >= 0
        and f.cache_write_tokens is not null
        and f.cache_write_tokens >= 0
        and f.cache_write_tokens <= f.cached_tokens
        and (
          (f.cached_tokens = 0 and f.cache_write_tokens = 0)
          or (f.cached_tokens > 0 and f.cache_write_tokens > 0)
        )
      ) as cache_split_rows_known
    from filtered f
    group by grouping sets ((), (f.tool), (f.model), (f.machine_id))
  ), encoded as (
    select
      a.*,
      (
        a.row_count = 0
        or coalesce(a.cache_split_rows_known, false)
      ) as cache_split_known,
      pg_catalog.jsonb_build_object(
        'cacheSplitKnown',
          a.row_count = 0 or coalesce(a.cache_split_rows_known, false),
        'cachedTokens', coalesce(a.cached_tokens, 0),
        'cacheWriteTokens', coalesce(a.cache_write_tokens, 0)
      ) as provenance
    from aggregated a
  )
  select
    coalesce(
      (pg_catalog.jsonb_agg(e.provenance)
        filter (where e.kind = 'summary')) -> 0,
      pg_catalog.jsonb_build_object(
        'cacheSplitKnown', true,
        'cachedTokens', 0,
        'cacheWriteTokens', 0
      )
    ),
    coalesce(
      pg_catalog.jsonb_object_agg(e.group_key, e.provenance)
        filter (where e.kind = 'tool'),
      '{}'::jsonb
    ),
    coalesce(
      pg_catalog.jsonb_object_agg(e.group_key, e.provenance)
        filter (where e.kind = 'model'),
      '{}'::jsonb
    ),
    coalesce(
      pg_catalog.jsonb_object_agg(e.group_key, e.provenance)
        filter (
          where e.kind = 'machine'
            and e.group_key is not null
            and e.group_key <> ''
        ),
      '{}'::jsonb
    )
    into
      v_summary_provenance,
      v_tool_provenance,
      v_model_provenance,
      v_machine_provenance
  from encoded e;

  v_response := private.get_dashboard_stats_v2_base_t63(p_user, v_query);

  v_item := (v_response -> 'summary') - 'cacheReadTokens' - 'cacheWriteTokens';
  if (v_summary_provenance ->> 'cacheSplitKnown')::boolean then
    v_item := v_item || pg_catalog.jsonb_build_object(
      'cacheReadTokens',
        (v_summary_provenance ->> 'cachedTokens')::bigint
        - (v_summary_provenance ->> 'cacheWriteTokens')::bigint,
      'cacheWriteTokens',
        (v_summary_provenance ->> 'cacheWriteTokens')::bigint
    );
  end if;
  v_response := pg_catalog.jsonb_set(v_response, '{summary}', v_item, true);

  for v_entry in select key, value from pg_catalog.jsonb_each(v_tool_provenance)
  loop
    v_item := v_response #> array['tools', v_entry.key];
    if v_item is null then continue; end if;
    v_item := v_item - 'cacheRead' - 'cacheWrite';
    if (v_entry.value ->> 'cacheSplitKnown')::boolean then
      v_item := v_item || pg_catalog.jsonb_build_object(
        'cacheRead',
          (v_entry.value ->> 'cachedTokens')::bigint
          - (v_entry.value ->> 'cacheWriteTokens')::bigint,
        'cacheWrite', (v_entry.value ->> 'cacheWriteTokens')::bigint
      );
    end if;
    v_response := pg_catalog.jsonb_set(
      v_response, array['tools', v_entry.key], v_item, true
    );
  end loop;

  for v_entry in select key, value from pg_catalog.jsonb_each(v_model_provenance)
  loop
    v_item := v_response #> array['models', v_entry.key];
    if v_item is null then continue; end if;
    v_item := v_item - 'cacheRead' - 'cacheWrite';
    if pg_catalog.jsonb_typeof(v_item -> 'cost') = 'null' then
      v_item := v_item - 'cost';
    end if;
    if (v_entry.value ->> 'cacheSplitKnown')::boolean then
      v_item := v_item || pg_catalog.jsonb_build_object(
        'cacheRead',
          (v_entry.value ->> 'cachedTokens')::bigint
          - (v_entry.value ->> 'cacheWriteTokens')::bigint,
        'cacheWrite', (v_entry.value ->> 'cacheWriteTokens')::bigint
      );
    end if;
    v_response := pg_catalog.jsonb_set(
      v_response, array['models', v_entry.key], v_item, true
    );
  end loop;

  for v_entry in select key, value from pg_catalog.jsonb_each(v_machine_provenance)
  loop
    select item into v_item
    from pg_catalog.jsonb_array_elements(v_response -> 'machineDistribution') as e(item)
    where item ->> 'value' = v_entry.key;
    if v_item is null then continue; end if;
    v_item := v_item - 'cacheReadTokens' - 'cacheWriteTokens';
    if (v_entry.value ->> 'cacheSplitKnown')::boolean then
      v_item := v_item || pg_catalog.jsonb_build_object(
        'cacheReadTokens',
          (v_entry.value ->> 'cachedTokens')::bigint
          - (v_entry.value ->> 'cacheWriteTokens')::bigint,
        'cacheWriteTokens', (v_entry.value ->> 'cacheWriteTokens')::bigint
      );
    end if;
    v_response := pg_catalog.jsonb_set(
      v_response,
      array[
        'machineDistribution',
        (select (e.ordinality - 1)::text
          from pg_catalog.jsonb_array_elements(v_response -> 'machineDistribution')
            with ordinality as e(item, ordinality)
          where e.item ->> 'value' = v_entry.key
          limit 1)
      ],
      v_item,
      true
    );
  end loop;

  return v_response;
end;
$$;

revoke execute on function private.get_dashboard_stats_v2_base_t63(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_dashboard_stats_v2(uuid, jsonb)
  from public, anon;
grant execute on function public.get_dashboard_stats_v2(uuid, jsonb)
  to authenticated, service_role;

comment on function public.get_dashboard_stats_v2(uuid, jsonb)
  is 'TokenLedger Stats v2 dashboard with conservative optional model-cost and cache provenance.';
