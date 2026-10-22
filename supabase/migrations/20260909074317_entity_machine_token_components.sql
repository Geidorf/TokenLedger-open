-- T10.137a: entity machine rows must expose the components needed to prove
-- effective Token. Keep the public signature and every query/filter boundary
-- unchanged; rewrite only the uniquely identified machine composition block.

do $migration$
declare
  v_signature constant pg_catalog.regprocedure :=
    'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)'::pg_catalog.regprocedure;
  v_definition text;
  v_json_needle constant text := $needle$        'tokens', d.tokens,
        'requests', d.requests,$needle$;
  v_json_replacement constant text := $replacement$        'tokens', d.tokens,
        'inputTokens', d.input_tokens,
        'outputTokens', d.output_tokens,
        'cachedTokens', d.cached_tokens,
        'requests', d.requests,$replacement$;
  v_select_needle constant text := $needle$      t.machine_id as value,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      pg_catalog.sum(t.requests)::bigint as requests,$needle$;
  v_select_replacement constant text := $replacement$      t.machine_id as value,
      pg_catalog.sum(t.input_tokens + t.output_tokens)::bigint as tokens,
      pg_catalog.sum(t.input_tokens)::bigint as input_tokens,
      pg_catalog.sum(t.output_tokens)::bigint as output_tokens,
      pg_catalog.sum(t.cached_tokens)::bigint as cached_tokens,
      pg_catalog.sum(t.requests)::bigint as requests,$replacement$;
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
    raise exception 'T10.137a entity dashboard security boundary changed';
  end if;

  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_json_needle, '')))
      / pg_catalog.length(v_json_needle) <> 1 then
    raise exception 'T10.137a entity machine JSON seam changed';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_json_needle, v_json_replacement);

  if (pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_select_needle, '')))
      / pg_catalog.length(v_select_needle) <> 1 then
    raise exception 'T10.137a entity machine aggregate seam changed';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_select_needle, v_select_replacement);

  execute v_definition;
end;
$migration$;
