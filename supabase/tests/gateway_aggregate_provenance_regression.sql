\set ON_ERROR_STOP on

-- T10.273: gateway-merged hourly aggregates (dashboard-stats-v2 §2.5).
begin;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '72730000-0000-4000-8000-000000000001',
    'gateway-aggregate@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  ),
  (
    '72730000-0000-4000-8000-000000000002',
    'gateway-aggregate-other@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  );

do $schema$
declare
  v_type text;
  v_nullable text;
  v_trigger text;
begin
  select data_type, is_nullable
    into v_type, v_nullable
    from information_schema.columns
   where table_schema = 'public' and table_name = 'token_logs' and column_name = 'gateway_requests';
  if v_type is distinct from 'bigint' or v_nullable is distinct from 'YES' then
    raise exception 'gateway_requests must be a nullable bigint, got % / %', v_type, v_nullable;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.token_logs'::regclass
       and conname = 'token_logs_gateway_requests_range'
       and convalidated
  ) then
    raise exception 'gateway_requests range constraint is missing or not validated';
  end if;
  select pg_catalog.pg_get_triggerdef(oid)
    into v_trigger
    from pg_catalog.pg_trigger
   where tgrelid = 'public.token_logs'::regclass and tgname = 'token_logs_sync';
  if v_trigger is null or v_trigger not like '%INSERT OR DELETE OR UPDATE%' then
    raise exception 'token_logs_sync must fire on insert, update and delete: %', v_trigger;
  end if;
  if not pg_catalog.has_column_privilege('authenticated', 'public.token_logs', 'gateway_requests', 'INSERT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.token_logs', 'gateway_requests', 'UPDATE') then
    raise exception 'authenticated clients cannot write gateway_requests';
  end if;
  if pg_catalog.has_column_privilege('anon', 'public.token_logs', 'gateway_requests', 'SELECT') then
    raise exception 'anon can read gateway_requests';
  end if;
end;
$schema$;

-- User B's aggregate exists before the RLS checks run.
insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
  timestamp, session_id, unique_key, cost_usd, machine_id, requests, gateway_requests
) values (
  '72730000-0000-4000-8000-000000000002', 'codex', 'gpt-5.5', 9000, 1000, 0, 0,
  pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.now() at time zone 'UTC') - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS'),
  'agg', 'agg_other_codex_gpt-5.5', 1.0, 'other-mac', 4, 4
);

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '72730000-0000-4000-8000-000000000001', true);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $writes$
declare
  v_hour text := pg_catalog.to_char(
    pg_catalog.date_trunc('hour', pg_catalog.now() at time zone 'UTC') - interval '1 hour',
    'YYYY-MM-DD HH24:MI:SS'
  );
  v_value bigint;
  v_count bigint;
begin
  -- An older client omits the column: provenance stays unknown.
  insert into public.token_logs (
    user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
    timestamp, session_id, unique_key, cost_usd, machine_id, requests
  ) values (
    '72730000-0000-4000-8000-000000000001', 'claude', 'claude-sonnet-4.5', 30, 6, 0, 0,
    v_hour, 'agg', 'agg_mac_claude_claude-sonnet-4.5_' || v_hour, 0.01, 'mac', 1
  );
  select gateway_requests into v_value from public.token_logs
   where unique_key = 'agg_mac_claude_claude-sonnet-4.5_' || v_hour;
  if v_value is not null then
    raise exception 'legacy upload must leave gateway_requests null, got %', v_value;
  end if;

  -- A merging client first uploads the scan-only aggregate, then the merged one
  -- for the same key (PostgREST merge-duplicates is an upsert on user_id, unique_key).
  insert into public.token_logs (
    user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
    timestamp, session_id, unique_key, cost_usd, machine_id, requests, gateway_requests
  ) values (
    '72730000-0000-4000-8000-000000000001', 'codex', 'gpt-5.5', 250, 90, 1500, 0,
    v_hour, 'agg', 'agg_mac_codex_gpt-5.5_' || v_hour, 0.2, 'mac', 2, 0
  );
  insert into public.token_logs (
    user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
    timestamp, session_id, unique_key, cost_usd, machine_id, requests, gateway_requests
  ) values (
    '72730000-0000-4000-8000-000000000001', 'codex', 'gpt-5.5', 260, 92, 1400, 0,
    v_hour, 'agg', 'agg_mac_codex_gpt-5.5_' || v_hour, 0.21, 'mac', 2, 2
  )
  on conflict (user_id, unique_key) do update
    set input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cached_tokens = excluded.cached_tokens,
        cost_usd = excluded.cost_usd,
        requests = excluded.requests,
        gateway_requests = excluded.gateway_requests;
  select count(*), max(gateway_requests) into v_count, v_value from public.token_logs
   where unique_key = 'agg_mac_codex_gpt-5.5_' || v_hour;
  if v_count <> 1 or v_value <> 2 then
    raise exception 'merged upsert must replace the scan-only aggregate: % rows, gateway_requests %', v_count, v_value;
  end if;

  -- A gateway-only aggregate (unknown agent) whose requests all came from the gateway.
  insert into public.token_logs (
    user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
    timestamp, session_id, unique_key, cost_usd, machine_id, requests, gateway_requests
  ) values (
    '72730000-0000-4000-8000-000000000001', 'gateway', 'deepseek-chat', 100, 20, 0, 0,
    v_hour, 'agg', 'agg_mac_gateway_deepseek-chat_' || v_hour, 0.001, 'mac', 1, 1
  );

  begin
    insert into public.token_logs (
      user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
      timestamp, session_id, unique_key, cost_usd, machine_id, requests, gateway_requests
    ) values (
      '72730000-0000-4000-8000-000000000001', 'codex', 'bad', 1, 1, 0, 0,
      v_hour, 'agg', 'agg_bad_over', 0, 'mac', 1, 2
    );
    raise exception 'gateway_requests above requests was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.token_logs (
      user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
      timestamp, session_id, unique_key, cost_usd, machine_id, requests, gateway_requests
    ) values (
      '72730000-0000-4000-8000-000000000001', 'codex', 'bad', 1, 1, 0, 0,
      v_hour, 'agg', 'agg_bad_negative', 0, 'mac', 1, -1
    );
    raise exception 'negative gateway_requests was accepted';
  exception when check_violation then null;
  end;

  -- RLS: another user's aggregates are invisible, unwritable and undeletable.
  select count(*) into v_count from public.token_logs
   where user_id = '72730000-0000-4000-8000-000000000002';
  if v_count <> 0 then
    raise exception 'RLS leaked % aggregate rows of another user', v_count;
  end if;
  begin
    insert into public.token_logs (
      user_id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
      timestamp, session_id, unique_key, cost_usd, machine_id, requests, gateway_requests
    ) values (
      '72730000-0000-4000-8000-000000000002', 'codex', 'gpt-5.5', 1, 1, 0, 0,
      v_hour, 'agg', 'agg_forged', 0, 'mac', 1, 1
    );
    raise exception 'RLS accepted an aggregate for another user';
  exception when insufficient_privilege then null;
  end;
  delete from public.token_logs where unique_key = 'agg_other_codex_gpt-5.5';
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'RLS allowed deleting another user''s aggregate';
  end if;
end;
$writes$;

-- RPCs sum the merged aggregates unchanged and never claim gatewayLedger.
do $rpc$
declare
  v_result jsonb;
begin
  v_result := public.get_dashboard_stats_v2(
    '72730000-0000-4000-8000-000000000001',
    '{"range":"all","timezone":"UTC","machines":[],"tools":[],"models":[],"search":null,"tokenMode":"effective"}'::jsonb
  );
  if (v_result #>> '{summary,totalTokens}')::bigint <> (30 + 6) + (260 + 92) + (100 + 20)
     or (v_result #>> '{summary,inputTokens}')::bigint <> 30 + 260 + 100
     or (v_result #>> '{summary,cachedTokens}')::bigint <> 1400
     or (v_result #>> '{summary,totalRequests}')::bigint <> 1 + 2 + 1 then
    raise exception 'merged aggregates changed the RPC summary: %', v_result -> 'summary';
  end if;
  if v_result #> '{meta,capabilities,gatewayLedger}' is not null then
    raise exception 'cloud RPC must not declare gatewayLedger: %', v_result #> '{meta,capabilities}';
  end if;
  if v_result #> '{tools,gateway}' is null then
    raise exception 'gateway-only aggregate is missing from tools: %', v_result -> 'tools';
  end if;
end;
$rpc$;

reset role;

-- Delete-only syncs mark the summaries dirty.
do $dirty$
declare
  v_before bigint;
  v_after bigint;
begin
  select dirty_generation into v_before from public.sync_state where id = 1;
  delete from public.token_logs
   where user_id = '72730000-0000-4000-8000-000000000001' and tool = 'claude';
  select dirty_generation into v_after from public.sync_state where id = 1;
  if v_after is distinct from v_before + 1 then
    raise exception 'delete did not mark summaries dirty: % -> %', v_before, v_after;
  end if;
end;
$dirty$;

rollback;
