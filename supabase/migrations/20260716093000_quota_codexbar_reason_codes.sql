-- Register the opt-in CodexBar bridge's bounded failure states without
-- changing quota-provider-v1 envelope semantics.
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
    'upstream_unavailable'
  ]::text[]);
$$;
