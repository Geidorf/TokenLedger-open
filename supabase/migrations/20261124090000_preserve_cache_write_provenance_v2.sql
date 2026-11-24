alter table public.token_logs add column if not exists cache_write_known boolean;

-- An older client can overwrite a bucket without sending the new column.
-- PostgREST may preserve omitted columns during an upsert. Clear the old
-- provenance when the replacement cache values arrive from a legacy writer.
create or replace function private.tokenledger_clear_legacy_cache_provenance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.current_setting('request.headers', true), '') <> ''
     and (pg_catalog.current_setting('request.headers', true)::jsonb ->> 'x-tokenledger-cache-provenance') is distinct from '1' then
    new.cache_write_known := case when tg_argv[0] = 'omitted' then false else null end;
  end if;
  return new;
end;
$$;

revoke all on function private.tokenledger_clear_legacy_cache_provenance() from public, anon, authenticated, service_role;

-- PostgreSQL runs same-kind triggers by name. The second trigger restores
-- legacy inference only when the writer explicitly updated the write column.
create trigger tokenledger_cache_01_assume_omitted_write
before update of cached_tokens on public.token_logs
for each row execute function private.tokenledger_clear_legacy_cache_provenance('omitted');

create trigger tokenledger_cache_02_explicit_write
before insert or update of cache_write_tokens on public.token_logs
for each row execute function private.tokenledger_clear_legacy_cache_provenance('explicit');

-- Keep the established v2 RPC shapes and scope rules. A mixed bucket keeps
-- combined cache counts and omits the split unless every row proves it.
create or replace function private.tokenledger_cache_split_proven(p_cached bigint, p_write bigint, p_known boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_cached is not null and p_write is not null
    and p_write >= 0 and p_write <= p_cached
    and coalesce(p_known, p_cached = 0 or p_write > 0);
$$;

revoke all on function private.tokenledger_cache_split_proven(bigint, bigint, boolean) from public, anon, authenticated, service_role;

-- Change the existing bodies in place so the custom range patches and the
-- permissions already applied by earlier migrations remain intact.
do $migration$
declare
  signature regprocedure;
  definition text;
  updated text;
  old_sum constant text := 'pg_catalog.sum(coalesce(t.cache_write_tokens, 0))::bigint as cache_write_tokens';
  new_sum constant text := 'case when pg_catalog.bool_and(private.tokenledger_cache_split_proven(t.cached_tokens, t.cache_write_tokens, t.cache_write_known)) then pg_catalog.sum(t.cache_write_tokens)::bigint end as cache_write_tokens';
  old_summary_sum constant text := 'coalesce(pg_catalog.sum(coalesce(t.cache_write_tokens, 0)), 0)::bigint as cache_write_tokens';
  new_summary_sum constant text := 'case when pg_catalog.count(*) = 0 then 0 when pg_catalog.bool_and(private.tokenledger_cache_split_proven(t.cached_tokens, t.cache_write_tokens, t.cache_write_known)) then pg_catalog.sum(t.cache_write_tokens)::bigint end as cache_write_tokens';
  entity_group text;
  old_entity constant text := $old$      ) order by d.tokens desc, pg_catalog.convert_to(d.value, 'UTF8')
    ), '[]'::jsonb
  ) into $old$;
  new_entity constant text := $new$      ) || case when d.cache_write_tokens is not null then pg_catalog.jsonb_build_object(
        'cacheReadTokens', d.cached_tokens - d.cache_write_tokens,
        'cacheWriteTokens', d.cache_write_tokens
      ) else '{}'::jsonb end order by d.tokens desc, pg_catalog.convert_to(d.value, 'UTF8')
    ), '[]'::jsonb
  ) into $new$;
begin
  signature := 'public.get_dashboard_stats_v2(uuid,jsonb)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(signature);
  updated := pg_catalog.replace(definition, $old$      t.cache_write_tokens,
      t.timestamp,$old$, $new$      t.cache_write_tokens,
      t.cache_write_known,
      t.timestamp,$new$);
  if updated = definition then raise exception 'cache dashboard input seam changed'; end if;
  definition := updated;
  updated := pg_catalog.replace(definition, $old$        f.cached_tokens >= 0
        and f.cache_write_tokens is not null
        and f.cache_write_tokens >= 0
        and f.cache_write_tokens <= f.cached_tokens
        and (
          (f.cached_tokens = 0 and f.cache_write_tokens = 0)
          or (f.cached_tokens > 0 and f.cache_write_tokens > 0)
        )$old$, '        private.tokenledger_cache_split_proven(f.cached_tokens, f.cache_write_tokens, f.cache_write_known)');
  if updated = definition then raise exception 'cache dashboard provenance seam changed'; end if;
  execute updated;

  signature := 'private.tokenledger_usage_summary_v2(uuid,text,text,jsonb,jsonb)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(signature);
  updated := pg_catalog.replace(definition, old_summary_sum, new_summary_sum);
  if updated = definition then raise exception 'cache summary aggregation seam changed'; end if;
  definition := updated;
  updated := pg_catalog.replace(definition, $old$    'cacheReadTokens', greatest(a.cached_tokens - a.cache_write_tokens, 0),
    'cacheWriteTokens', a.cache_write_tokens,
$old$, '');
  if updated = definition then raise exception 'cache summary response seam changed'; end if;
  definition := updated;
  updated := pg_catalog.replace(definition, ') into v_result', $new$) || case when a.cache_write_tokens is not null then pg_catalog.jsonb_build_object(
    'cacheReadTokens', a.cached_tokens - a.cache_write_tokens,
    'cacheWriteTokens', a.cache_write_tokens
  ) else '{}'::jsonb end into v_result$new$);
  if updated = definition then raise exception 'cache summary result seam changed'; end if;
  execute updated;

  signature := 'private.tokenledger_usage_details_core_v2(uuid,jsonb,jsonb,text,integer)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(signature);
  updated := pg_catalog.replace(definition, 'coalesce(t.cache_write_tokens, 0) as cache_write_tokens',
    'case when private.tokenledger_cache_split_proven(t.cached_tokens, t.cache_write_tokens, t.cache_write_known) then t.cache_write_tokens end as cache_write_tokens');
  if updated = definition then raise exception 'cache detail input seam changed'; end if;
  definition := updated;
  updated := pg_catalog.replace(definition, $old$          'cacheWriteTokens', c.cache_write_tokens,
$old$, '');
  if updated = definition then raise exception 'cache detail response seam changed'; end if;
  definition := updated;
  updated := pg_catalog.replace(definition, $old$        ) order by c.timestamp desc, c.id desc$old$, $new$        ) || case when c.cache_write_tokens is not null then pg_catalog.jsonb_build_object(
          'cacheReadTokens', c.cached_tokens - c.cache_write_tokens,
          'cacheWriteTokens', c.cache_write_tokens
        ) else '{}'::jsonb end order by c.timestamp desc, c.id desc$new$);
  if updated = definition then raise exception 'cache detail result seam changed'; end if;
  execute updated;

  signature := 'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(signature);
  updated := pg_catalog.replace(definition, old_sum, new_sum);
  if updated = definition then raise exception 'cache entity aggregation seam changed'; end if;
  definition := updated;
  updated := pg_catalog.replace(definition, $old$        'cacheWriteTokens', d.cache_write_tokens,
$old$, '');
  if updated = definition then raise exception 'cache entity response seam changed'; end if;
  definition := updated;
  foreach entity_group in array array['v_by_tools', 'v_by_models'] loop
    updated := pg_catalog.replace(definition, old_entity || entity_group, new_entity || entity_group);
    if updated = definition then raise exception 'cache entity result seam changed: %', entity_group; end if;
    definition := updated;
  end loop;
  execute definition;
end;
$migration$;
