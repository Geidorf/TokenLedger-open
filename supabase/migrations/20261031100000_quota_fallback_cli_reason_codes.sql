-- 额度快照白名单追加兜底 CLI 原因码，保留当前所有允许值。
-- 复制当前定义，避免重列历史原因码；原入口使用 create or replace 保留 OID。
do $$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'private.quota_snapshot_reason_valid_v1(text)'::regprocedure
  );
  v_original_name text := 'private.quota_snapshot_reason_valid_v1';
  v_base_name text := 'private.quota_snapshot_reason_base_v1';
begin
  if pg_catalog.strpos(v_definition, 'CREATE OR REPLACE FUNCTION ' || v_original_name || '(') <> 1
     or (pg_catalog.length(v_definition)
       - pg_catalog.length(pg_catalog.replace(v_definition, v_original_name, '')))
       <> pg_catalog.length(v_original_name) then
    raise exception 'quota reason whitelist definition must contain exactly one function name';
  end if;
  v_definition := pg_catalog.replace(v_definition, v_original_name, v_base_name);
  if pg_catalog.strpos(v_definition, v_base_name) = 0
     or pg_catalog.strpos(v_definition, v_original_name) > 0 then
    raise exception 'quota reason whitelist base copy failed';
  end if;
  execute v_definition;
end;
$$;

create or replace function private.quota_snapshot_reason_valid_v1(p_reason text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_reason = any(array[
    'claude_fallback_cli_unavailable',
    'claude_fallback_cli_timeout',
    'claude_fallback_cli_response_invalid'
  ]::text[]) or private.quota_snapshot_reason_base_v1(p_reason);
$$;

revoke execute on function private.quota_snapshot_reason_base_v1(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.quota_snapshot_reason_valid_v1(text)
  from public, anon, authenticated, service_role;

comment on function private.quota_snapshot_reason_base_v1(text)
  is '额度快照历史原因码白名单，供兜底 CLI 原因码扩展复用。';
comment on function private.quota_snapshot_reason_valid_v1(text)
  is '额度快照原因码白名单，兼容历史值并追加兜底 CLI 原因码。';
