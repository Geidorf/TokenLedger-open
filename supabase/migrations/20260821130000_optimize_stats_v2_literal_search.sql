-- Keep Stats v2 literal-search semantics while avoiding repeated work per row.
--
-- The search contract is intentionally not changed: ASCII A-Z folds to a-z,
-- non-ASCII text stays case-sensitive, and %, _ and \ remain literals. The
-- previous SQL function folded the same search needle once for every field;
-- this PL/pgSQL implementation folds it once per candidate row instead.
create or replace function private.tokenledger_search_match_v2(
  p_search text,
  p_tool text,
  p_model text,
  p_machine text,
  p_session text
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_search text;
begin
  if p_search is null then
    return true;
  end if;

  if pg_catalog.octet_length(p_search) = pg_catalog.char_length(p_search) then
    v_search := pg_catalog.translate(
      p_search,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxyz'
    );

    return pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_tool, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        v_search
      ) > 0
      or pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_model, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        v_search
      ) > 0
      or pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_machine, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        v_search
      ) > 0
      or pg_catalog.strpos(
        pg_catalog.translate(coalesce(p_session, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
        v_search
      ) > 0;
  end if;

  return pg_catalog.strpos(coalesce(p_tool, ''), p_search) > 0
    or pg_catalog.strpos(coalesce(p_model, ''), p_search) > 0
    or pg_catalog.strpos(coalesce(p_machine, ''), p_search) > 0
    or pg_catalog.strpos(coalesce(p_session, ''), p_search) > 0;
end;
$$;
