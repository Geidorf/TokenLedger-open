-- M10 release security hardening.
--
-- This migration intentionally does not change any public RPC signature or
-- StatsData/Quota payload. It closes the mutable-search-path findings reported
-- by Supabase Database Advisors and makes sync_state read-only by privilege as
-- well as by RLS. SECURITY DEFINER trigger/RPC code continues to update the
-- singleton row as the owning role.

alter function public.set_updated_at()
  set search_path = '';

alter function private.tokenledger_ascii_trim_v2(text)
  set search_path = '';

alter function private.tokenledger_search_match_v2(text, text, text, text, text)
  set search_path = '';

-- A false FOR ALL policy also participates in SELECT policy composition and
-- triggers the multiple-permissive-policy Advisor. PostgreSQL denies an
-- operation when no applicable policy exists, so removing it keeps writes
-- denied while leaving the explicit authenticated read policy unchanged.
drop policy if exists "sync_state_modify_blocked" on public.sync_state;

-- Older Supabase projects may have inherited broad Data API table grants.
-- Make the intended boundary explicit: clients can inspect freshness, but only
-- owner-executed trigger/RPC code may mutate the singleton.
revoke all privileges on table public.sync_state
  from public, anon, authenticated;
grant select on table public.sync_state
  to authenticated;
