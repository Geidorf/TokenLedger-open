-- T10.88 follow-up: comparison day buckets are public contract values.
-- The frozen helper used D01/D02 labels, which are implementation indexes and
-- cannot be reconciled with the source timezone or safely consumed by clients.
-- Rewrite only that producer branch; hour and month/year contracts remain
-- unchanged.
do $migration$
declare
  v_definition text;
  v_needle constant text := $needle$else 'D' || pg_catalog.lpad((g + 1)::text, 2, '0') end as bucket$needle$;
  v_replacement constant text := $replacement$else pg_catalog.to_char(p_start::date + g, 'YYYY-MM-DD') end as bucket$replacement$;
begin
  select pg_catalog.pg_get_functiondef(
    'private.tokenledger_usage_series_v2(uuid,timestamp,timestamp,text,jsonb,jsonb)'::pg_catalog.regprocedure
  ) into v_definition;

  if pg_catalog.strpos(v_definition, v_needle) = 0 then
    raise exception 'T10.88 expected legacy day bucket producer was not found';
  end if;
  if pg_catalog.strpos(
    pg_catalog.substr(v_definition, pg_catalog.strpos(v_definition, v_needle) + pg_catalog.length(v_needle)),
    v_needle
  ) > 0 then
    raise exception 'T10.88 day bucket producer shape is ambiguous';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);
  execute v_definition;
end;
$migration$;
