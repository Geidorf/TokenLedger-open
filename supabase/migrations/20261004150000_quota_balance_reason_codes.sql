-- Migration: 20261004150000_quota_balance_reason_codes.sql
-- Description (T10.288, ADR-018 U-108, quota-provider-v1 §4/§6.1):
--   Vendor balance Providers (balance-*) now sync through transport v3. Their
--   LKG `stale` envelopes carry reason codes that the server whitelist did
--   not yet list, which made the whole upsert fail with invalid_payload:
--     * balance_unavailable        (new, registered by T10.288)
--     * api_key_required           (registered in §4, never added here)
--     * secure_storage_unavailable (registered in §4, never added here)
--
--   Only private.quota_snapshot_reason_valid_v1 changes; its body follows
--   20260716093000 with the three codes appended. The v1/v2 validators and
--   the v2/v1 projections are untouched, so envelopes with currency windows
--   are still omitted from every v1/v2 read. RLS and grants are restated
--   unchanged.

alter table private.quota_snapshot_state enable row level security;
alter table private.quota_snapshot_state force row level security;
alter table private.quota_snapshots enable row level security;
alter table private.quota_snapshots force row level security;
revoke all on table private.quota_snapshot_state
  from public, anon, authenticated, service_role;
revoke all on table private.quota_snapshots
  from public, anon, authenticated, service_role;

create or replace function private.quota_snapshot_reason_valid_v1(p_reason text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_reason = any(array[
    'local_authorization_required',
    'app_server_unavailable',
    'app_server_timeout',
    'app_server_auth_required',
    'consumer_api_unavailable',
    'source_not_found',
    'permission_denied',
    'source_schema_unsupported',
    'source_scan_truncated',
    'source_temporarily_unavailable',
    'provider_worker_failed',
    'provider_cache_unavailable',
    'claude_local_authorization_required',
    'claude_statusline_snapshot_missing',
    'claude_statusline_snapshot_invalid',
    'claude_codexbar_unavailable',
    'claude_codexbar_timeout',
    'claude_codexbar_response_invalid',
    'observation_stale',
    'reset_elapsed',
    'credits_unlimited',
    'admin_key_required',
    'rate_limited',
    'upstream_unavailable',
    'secure_storage_unavailable',
    'api_key_required',
    'balance_unavailable'
  ]::text[]);
$$;

revoke execute on function private.quota_snapshot_reason_valid_v1(text)
  from public, anon, authenticated, service_role;

comment on function private.quota_snapshot_reason_valid_v1(text)
  is 'quota-provider-v1 §4 reason code whitelist shared by every quota transport validator.';
