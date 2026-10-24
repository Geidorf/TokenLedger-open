-- Supabase privilege hardening (v9).
--
-- No public RPC signature or response payload changes. This migration:
--   1) makes the global refresh bookkeeping row (sync_state) readable only by
--      service_role and owner-executed SECURITY DEFINER code; no client reads it;
--   2) aligns the legacy v1 RPCs get_dashboard_stats/get_yesterday_stats with
--      the v2 ownership check and an empty fixed search_path;
--   3) moves pgcrypto out of the public schema into extensions;
--   4) revokes TRUNCATE/TRIGGER/REFERENCES on token_logs from client roles.

-- ---------------------------------------------------------------------------
-- 1) sync_state: service_role only.
-- ---------------------------------------------------------------------------

-- RLS stays enabled with no client policy, so any re-granted privilege is
-- still denied row access.
drop policy if exists "sync_state_select_own" on public.sync_state;

revoke all privileges on table public.sync_state
  from public, anon, authenticated;
grant select on table public.sync_state
  to service_role;

-- ---------------------------------------------------------------------------
-- 2) Legacy v1 dashboard RPCs: v2 ownership check and empty search_path.
-- ---------------------------------------------------------------------------

do $migration$
declare
  v_signature regprocedure;
  v_definition text;
  v_needle constant text :=
    'if auth.uid() is null or auth.uid() <> p_user then';
  v_replacement constant text :=
    'if p_user is null or (select auth.uid()) is distinct from p_user then';
begin
  foreach v_signature in array array[
    'public.get_dashboard_stats(uuid,text,text,text)'::pg_catalog.regprocedure,
    'public.get_yesterday_stats(uuid,text,text)'::pg_catalog.regprocedure
  ]
  loop
    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
    v_definition := pg_catalog.replace(v_definition, E'\r\n', E'\n');

    if not exists (
      select 1
      from pg_catalog.pg_proc p
      where p.oid = v_signature
        and p.prosecdef
    ) then
      raise exception 'security hardening: % must remain SECURITY DEFINER', v_signature;
    end if;
    if (pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, '')))
        / pg_catalog.length(v_needle) <> 1 then
      raise exception 'security hardening: % ownership seam changed', v_signature;
    end if;

    execute pg_catalog.replace(v_definition, v_needle, v_replacement);
  end loop;
end;
$migration$;

-- Every object both bodies reference is already schema-qualified.
alter function public.get_dashboard_stats(uuid, text, text, text)
  set search_path = '';
alter function public.get_yesterday_stats(uuid, text, text)
  set search_path = '';

revoke execute on function public.get_dashboard_stats(uuid, text, text, text)
  from public, anon;
grant execute on function public.get_dashboard_stats(uuid, text, text, text)
  to authenticated, service_role;
revoke execute on function public.get_yesterday_stats(uuid, text, text)
  from public, anon;
grant execute on function public.get_yesterday_stats(uuid, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) pgcrypto lives in extensions, not public.
-- ---------------------------------------------------------------------------

-- Hosted projects already install it in extensions; only a project that
-- replayed the baseline on a bare database has it in public. No TokenLedger
-- function calls a pgcrypto function.
create schema if not exists extensions;

do $migration$
begin
  if exists (
    select 1
    from pg_catalog.pg_extension e
    where e.extname = 'pgcrypto'
      and e.extnamespace = 'public'::pg_catalog.regnamespace
  ) then
    alter extension pgcrypto set schema extensions;
  end if;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 4) token_logs: clients keep only the row operations RLS governs.
-- ---------------------------------------------------------------------------

revoke truncate, trigger, references on table public.token_logs
  from public, anon, authenticated;
