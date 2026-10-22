-- T10.118b: add query-bound daily estimated costs to the optional Stats v2
-- surface. Keep the established required cost fields and cache provenance
-- behavior intact; the new field is computed from the same materialized,
-- canonical filtered row set used by the public dashboard wrapper.

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
    raise exception 'T10.118b dashboard must remain SECURITY DEFINER with empty search_path';
  end if;
  if (
    pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(
          v_definition,
          '(select auth.uid()) is distinct from p_user',
          ''
        ))
  ) / pg_catalog.length('(select auth.uid()) is distinct from p_user') <> 1 then
    raise exception 'T10.118b dashboard auth.uid ownership seam changed';
  end if;

  v_needle := $needle$  v_machine_provenance jsonb;
  v_response jsonb;$needle$;
  v_replacement := $replacement$  v_machine_provenance jsonb;
  v_daily_costs jsonb;
  v_response jsonb;$replacement$;
  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, '')))
      / pg_catalog.length(v_needle) <> 1 then
    raise exception 'T10.118b dashboard declaration seam changed';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$      t.machine_id,
      t.cached_tokens,
      t.cache_write_tokens
    from public.token_logs t$needle$;
  v_replacement := $replacement$      t.machine_id,
      t.cached_tokens,
      t.cache_write_tokens,
      t.timestamp,
      t.input_tokens,
      t.output_tokens,
      t.cost_usd
    from public.token_logs t$replacement$;
  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, '')))
      / pg_catalog.length(v_needle) <> 1 then
    raise exception 'T10.118b dashboard filtered projection seam changed';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$  ), encoded as (
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
  select$needle$;
  v_replacement := $replacement$  ), encoded as (
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
  ), daily as (
    select
      public.immutable_date_parse(f.timestamp)::text as local_date,
      pg_catalog.sum(
        f.input_tokens::numeric + f.output_tokens::numeric
      ) as effective_tokens,
      pg_catalog.bool_or(f.cost_usd is null) as has_missing_cost,
      pg_catalog.bool_or(
        f.cost_usd is not null
        and (
          f.cost_usd < 0::double precision
          or f.cost_usd = '-Infinity'::double precision
          or f.cost_usd = 'Infinity'::double precision
          or f.cost_usd = 'NaN'::double precision
        )
      ) as has_invalid_cost,
      pg_catalog.bool_or(
        f.cost_usd = 0::double precision
      ) as has_legacy_zero,
      pg_catalog.sum(
        case
          when f.cost_usd > 0::double precision
            and f.cost_usd < 'Infinity'::double precision
            then f.cost_usd::numeric
          else 0::numeric
        end
      ) as finite_positive_cost
    from filtered f
    group by public.immutable_date_parse(f.timestamp)
  ), daily_encoded as (
    select
      d.local_date,
      case
        when d.has_missing_cost then pg_catalog.jsonb_build_object(
          'date', d.local_date,
          'amountUsd', null,
          'status', 'unavailable',
          'reason', 'missing-cost'
        )
        when d.has_invalid_cost
          or d.finite_positive_cost > 1.7976931348623157e308::numeric
          then pg_catalog.jsonb_build_object(
            'date', d.local_date,
            'amountUsd', null,
            'status', 'unavailable',
            'reason', 'invalid-cost'
          )
        when d.has_legacy_zero then pg_catalog.jsonb_build_object(
          'date', d.local_date,
          'amountUsd', null,
          'status', 'unavailable',
          'reason', 'legacy-zero'
        )
        else pg_catalog.jsonb_build_object(
          'date', d.local_date,
          'amountUsd', d.finite_positive_cost::double precision,
          'status', 'recorded-estimate'
        )
      end as item
    from daily d
    where d.local_date is not null
      and d.effective_tokens > 0::numeric
  )
  select$replacement$;
  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, '')))
      / pg_catalog.length(v_needle) <> 1 then
    raise exception 'T10.118b dashboard aggregate seam changed';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$    into
      v_summary_provenance,
      v_tool_provenance,
      v_model_provenance,
      v_machine_provenance
  from encoded e;$needle$;
  v_replacement := $replacement$    , pg_catalog.jsonb_build_object(
      'coverage', pg_catalog.jsonb_build_object(
        'start', case when v_range = 'all'
          then null
          else pg_catalog.substr(v_start_text, 1, 10)
        end,
        'end', pg_catalog.substr(v_end_text, 1, 10),
        'timezone', v_timezone,
        'state', 'complete'
      ),
      'days', coalesce(
        (select pg_catalog.jsonb_agg(d.item order by d.local_date)
          from daily_encoded d),
        '[]'::jsonb
      )
    )
    into
      v_summary_provenance,
      v_tool_provenance,
      v_model_provenance,
      v_machine_provenance,
      v_daily_costs
  from encoded e;$replacement$;
  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, '')))
      / pg_catalog.length(v_needle) <> 1 then
    raise exception 'T10.118b dashboard result seam changed';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);

  v_needle := $needle$  v_response := private.get_dashboard_stats_v2_base_t63(p_user, v_query);

  v_item := (v_response -> 'summary')$needle$;
  v_replacement := $replacement$  v_response := private.get_dashboard_stats_v2_base_t63(p_user, v_query);
  v_response := v_response || pg_catalog.jsonb_build_object(
    'dailyCosts', v_daily_costs
  );

  v_item := (v_response -> 'summary')$replacement$;
  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, '')))
      / pg_catalog.length(v_needle) <> 1 then
    raise exception 'T10.118b dashboard response seam changed';
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
  is 'TokenLedger Stats v2 dashboard with optional query-bound daily estimated costs and conservative cache provenance.';
