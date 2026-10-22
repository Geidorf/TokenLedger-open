\set ON_ERROR_STOP on

begin;

insert into auth.users (
  id,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '11111111-1111-1111-1111-111111111111',
    'stats-v2-user-one@example.invalid',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'stats-v2-user-two@example.invalid',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.token_logs (
  user_id,
  tool,
  model,
  input_tokens,
  output_tokens,
  cached_tokens,
  cache_write_tokens,
  timestamp,
  session_id,
  unique_key,
  cost_usd,
  machine_id,
  requests
) values
  -- Keep "current" fixtures inside the UTC today window even when CI starts
  -- just after midnight. The explicit previous-day row below remains the
  -- comparison fixture; without this clamp, -10 minutes crosses the date.
  (
    '11111111-1111-1111-1111-111111111111',
    'Codex',
    'gpt-5',
    100,
    50,
    20,
    5,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '5 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'session-current-a',
    'stats-v2-current-a',
    0.10,
    'mac-one',
    1
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'Codex',
    'gpt-5',
    80,
    20,
    10,
    2,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '5 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'session-current-b',
    'stats-v2-current-b',
    0.08,
    'mac-one',
    1
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'Claude',
    'opus',
    200,
    100,
    0,
    0,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '10 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'session-current-c',
    'stats-v2-current-c',
    0.20,
    'windows-one',
    1
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'Codex',
    'gpt-5',
    50,
    25,
    0,
    0,
    -- Anchor the previous fixture to the same wall-clock minute yesterday so
    -- it remains inside the aligned previous calendar window across midnight.
    to_char(now() at time zone 'UTC' - interval '1 day', 'YYYY-MM-DD HH24:MI:SS'),
    'session-previous-a',
    'stats-v2-previous-a',
    0.05,
    'mac-one',
    1
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'Codex',
    'gpt-5',
    9000,
    1000,
    0,
    0,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '5 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'session-other-user',
    'stats-v2-other-user',
    10.00,
    'other-machine',
    1
  );

do $$
declare
  v_signature text;
begin
  if has_table_privilege('anon', 'public.token_logs', 'select') then
    raise exception 'anon unexpectedly has token_logs SELECT';
  end if;
  if not has_table_privilege('authenticated', 'public.token_logs', 'select,insert,update,delete') then
    raise exception 'authenticated is missing token_logs sync privileges';
  end if;
  if has_function_privilege(
    'anon',
    'public.get_usage_details_v1(uuid,text,text,text,text,text,text,integer)',
    'execute'
  ) then
    raise exception 'anon unexpectedly has get_usage_details_v1 EXECUTE';
  end if;
  if has_schema_privilege('authenticated', 'private', 'usage') then
    raise exception 'authenticated unexpectedly has private schema USAGE';
  end if;
  if has_schema_privilege('service_role', 'private', 'usage') then
    raise exception 'service_role unexpectedly has private schema USAGE';
  end if;

  foreach v_signature in array array[
    'public.get_dashboard_stats_v2(uuid,jsonb)',
    'public.get_usage_comparison_v2(uuid,jsonb)',
    'public.get_usage_details_v2(uuid,jsonb,text,integer)',
    'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)'
  ]
  loop
    if has_function_privilege('anon', v_signature, 'execute') then
      raise exception 'anon unexpectedly has % EXECUTE', v_signature;
    end if;
    if not has_function_privilege('authenticated', v_signature, 'execute') then
      raise exception 'authenticated is missing % EXECUTE', v_signature;
    end if;
  end loop;
  if has_function_privilege(
    'authenticated',
    'private.get_dashboard_stats_v2_base_t63(uuid,jsonb)',
    'execute'
  ) then
    raise exception 'authenticated unexpectedly has dashboard v2 base EXECUTE';
  end if;

  if not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'token_logs'
      and c.column_name = 'cache_write_tokens'
      and c.is_nullable = 'YES'
      and c.column_default is null
  ) then
    raise exception 'cache_write_tokens must preserve missing provenance as SQL null';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'get_dashboard_stats_v2'
      and p.prosecdef
      and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'dashboard v2 must remain SECURITY DEFINER with fixed empty search_path';
  end if;

  if to_regprocedure('public.get_dashboard_stats(uuid,text,text,text)') is null
     or to_regprocedure('public.get_usage_details_v1(uuid,text,text,text,text,text,text,integer)') is null
     or to_regprocedure('public.get_usage_comparison_v1(uuid,text,text,text,text,text)') is null
     or to_regprocedure('public.get_usage_entity_dashboard_v1(uuid,text,text,text,text,text)') is null then
    raise exception 'one or more legacy RPC signatures disappeared';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'get_dashboard_stats_v2',
        'get_usage_comparison_v2',
        'get_usage_details_v2',
        'get_usage_entity_dashboard_v2'
      ])
      and (
        not p.prosecdef
        or not (coalesce(p.proconfig, array[]::text[]) @> array['search_path=""'])
      )
  ) then
    raise exception 'v2 RPC must be security definer with an empty search_path';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_page_one jsonb;
  v_page_two jsonb;
  v_filtered jsonb;
  v_comparison jsonb;
  v_entity jsonb;
  v_cursor text;
  v_first_page_ids bigint[];
  v_second_page_ids bigint[];
begin
  if (select count(*) from public.token_logs) <> 4 then
    raise exception 'RLS did not isolate the authenticated user';
  end if;

  v_page_one := public.get_usage_details_v1(
    '11111111-1111-1111-1111-111111111111',
    'today',
    null,
    null,
    null,
    'UTC',
    null,
    2
  );

  if (v_page_one ->> 'totalCount')::bigint <> 3 then
    raise exception 'unexpected today totalCount: %', v_page_one ->> 'totalCount';
  end if;
  if jsonb_array_length(v_page_one -> 'items') <> 2 or not (v_page_one ->> 'hasMore')::boolean then
    raise exception 'first keyset page shape is incorrect: %', v_page_one;
  end if;

  v_cursor := v_page_one ->> 'nextCursor';
  if v_cursor is null or v_cursor !~ '^v1\.[0-9a-f]+\.[0-9]+$' then
    raise exception 'cursor encoding is incorrect: %', v_cursor;
  end if;

  v_page_two := public.get_usage_details_v1(
    '11111111-1111-1111-1111-111111111111',
    'today',
    null,
    null,
    null,
    'UTC',
    v_cursor,
    2
  );

  select array_agg((item ->> 'id')::bigint order by (item ->> 'id')::bigint)
    into v_first_page_ids
    from jsonb_array_elements(v_page_one -> 'items') item;
  select array_agg((item ->> 'id')::bigint order by (item ->> 'id')::bigint)
    into v_second_page_ids
    from jsonb_array_elements(v_page_two -> 'items') item;

  if jsonb_array_length(v_page_two -> 'items') <> 1 or (v_page_two ->> 'hasMore')::boolean then
    raise exception 'second keyset page shape is incorrect: %', v_page_two;
  end if;
  if v_first_page_ids && v_second_page_ids then
    raise exception 'keyset pages overlap: % / %', v_first_page_ids, v_second_page_ids;
  end if;

  v_filtered := public.get_usage_details_v1(
    '11111111-1111-1111-1111-111111111111',
    'today',
    null,
    null,
    'gpt-5',
    'UTC',
    null,
    1000
  );
  if (v_filtered ->> 'totalCount')::bigint <> 2 then
    raise exception 'model filter count is incorrect: %', v_filtered;
  end if;
  if jsonb_array_length(v_filtered -> 'availableFilters' -> 'models') <> 2 then
    raise exception 'self-dimension facet should retain switchable models: %', v_filtered;
  end if;
  if jsonb_array_length(v_filtered -> 'items') <> 2 then
    raise exception 'limit clamp or filtered items are incorrect: %', v_filtered;
  end if;

  v_comparison := public.get_usage_comparison_v1(
    '11111111-1111-1111-1111-111111111111',
    'today',
    null,
    null,
    null,
    'UTC'
  );
  if v_comparison #>> '{window,kind}' <> 'dayOverDay' then
    raise exception 'comparison kind is incorrect: %', v_comparison;
  end if;
  if (v_comparison #>> '{current,summary,totalTokens}')::bigint <> 550 then
    raise exception 'current comparison total is incorrect: %', v_comparison;
  end if;
  if (v_comparison #>> '{previous,summary,totalTokens}')::bigint <> 75 then
    raise exception 'previous comparison total is incorrect: %', v_comparison;
  end if;
  if v_comparison #>> '{delta,tokens,direction}' <> 'up' then
    raise exception 'comparison delta direction is incorrect: %', v_comparison;
  end if;
  if public.get_usage_comparison_v1(
    '11111111-1111-1111-1111-111111111111',
    'year',
    null,
    null,
    null,
    'UTC'
  ) is not null then
    raise exception 'year comparison must be null';
  end if;

  v_entity := public.get_usage_entity_dashboard_v1(
    '11111111-1111-1111-1111-111111111111',
    'today',
    null,
    null,
    'gpt-5',
    'UTC'
  );
  if v_entity #>> '{entity,kind}' <> 'model'
     or (v_entity #>> '{summary,totalTokens}')::bigint <> 250 then
    raise exception 'model entity dashboard is incorrect: %', v_entity;
  end if;

  begin
    perform public.get_usage_details_v1(
      '22222222-2222-2222-2222-222222222222',
      'today',
      null,
      null,
      null,
      'UTC',
      null,
      50
    );
    raise exception 'user mismatch unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.get_usage_details_v1(
      '11111111-1111-1111-1111-111111111111',
      'today',
      null,
      null,
      null,
      'UTC',
      'not-a-cursor',
      50
    );
    raise exception 'invalid cursor unexpectedly succeeded';
  exception
    when invalid_parameter_value then null;
  end;
end;
$$;

reset role;

-- Dedicated v2 search fixtures. These are inserted after the v1 assertions so
-- the established v1 totals remain a regression lock for old clients.
insert into public.token_logs (
  user_id,
  tool,
  model,
  input_tokens,
  output_tokens,
  cached_tokens,
  cache_write_tokens,
  timestamp,
  session_id,
  unique_key,
  cost_usd,
  machine_id,
  requests
) values
  (
    '11111111-1111-1111-1111-111111111111',
    'Percent%Tool',
    'literal-model',
    1,
    1,
    0,
    0,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '1 minute',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'literal-percent',
    'stats-v2-literal-percent',
    0.01,
    'literal-machine',
    1
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'Under_score',
    'literal-model',
    1,
    1,
    0,
    0,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '2 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'literal-underscore',
    'stats-v2-literal-underscore',
    0.01,
    'literal-machine',
    1
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'Back' || chr(92) || 'Slash',
    'literal-model',
    1,
    1,
    0,
    0,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '3 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'literal-backslash',
    'stats-v2-literal-backslash',
    0.01,
    'literal-machine',
    1
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    'ASCII-CODEX',
    'literal-model',
    1,
    1,
    0,
    0,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '4 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'MixedCaseSession',
    'stats-v2-ascii-case',
    0.01,
    'literal-machine',
    1
  ),
  (
    '11111111-1111-1111-1111-111111111111',
    '工具',
    '模型A',
    1,
    1,
    0,
    0,
    to_char(
      greatest(
        now() at time zone 'UTC' - interval '6 minutes',
        date_trunc('day', now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'unicode-case',
    'stats-v2-unicode-case',
    0.01,
    'literal-machine',
    1
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_query jsonb;
  v_canonical_query jsonb;
  v_page_one jsonb;
  v_page_two jsonb;
  v_result jsonb;
  v_dashboard jsonb;
  v_comparison jsonb;
  v_week_comparison jsonb;
  v_entity jsonb;
  v_cursor text;
begin
  v_dashboard := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"today","timezone":"UTC","machines":[],"tools":[],"models":[],"search":"session-current","tokenMode":"effective"}'::jsonb
  );
  -- NULL-safe：`jsonb_array_length(NULL) <> 2` 得到 NULL，PL/pgSQL 的 IF 把它当假，
  -- 20260901142623 丢掉 machineDistribution 时这段断言就是这样静默放行的。
  if v_dashboard -> 'machineDistribution' is null
     or pg_catalog.jsonb_typeof(v_dashboard -> 'machineDistribution') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_dashboard -> 'machineDistribution') is distinct from 2
     or v_dashboard #>> '{machineDistribution,0,value}' is distinct from 'windows-one'
     or (v_dashboard #>> '{machineDistribution,0,tokens}')::bigint is distinct from 300
     or (v_dashboard #>> '{machineDistribution,0,requests}')::bigint is distinct from 1
     or v_dashboard #>> '{machineDistribution,1,value}' is distinct from 'mac-one'
     or (v_dashboard #>> '{machineDistribution,1,tokens}')::bigint is distinct from 250
     or (v_dashboard #>> '{machineDistribution,1,requests}')::bigint is distinct from 2 then
    raise exception 'dashboard machine distribution is not query-bound or deterministically sorted: %',
      v_dashboard -> 'machineDistribution';
  end if;

  v_query := pg_catalog.jsonb_build_object(
    'range', 'today',
    'timezone', 'UTC',
    'machines', pg_catalog.jsonb_build_array(' windows-one ', 'mac-one', 'mac-one'),
    'tools', pg_catalog.jsonb_build_array('Codex', 'Claude', 'Codex'),
    'models', pg_catalog.jsonb_build_array('opus', 'gpt-5', 'gpt-5'),
    'search', E' \tSESSION-CURRENT\r ',
    'tokenMode', 'effective'
  );
  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111', v_query, null, 50
  );
  v_canonical_query := v_result #> '{meta,query}';
  if v_canonical_query -> 'machines' <> '["mac-one", "windows-one"]'::jsonb
     or v_canonical_query -> 'tools' <> '["Claude", "Codex"]'::jsonb
     or v_canonical_query -> 'models' <> '["gpt-5", "opus"]'::jsonb
     or v_canonical_query ->> 'search' <> 'SESSION-CURRENT'
     or v_canonical_query ? 'machine'
     or v_canonical_query ? 'tool'
     or v_canonical_query ? 'model' then
    raise exception 'canonical multi-value echo is incorrect: %', v_canonical_query;
  end if;
  if (v_result ->> 'totalCount')::bigint <> 3 then
    raise exception 'same-dimension OR query is incorrect: %', v_result;
  end if;

  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    pg_catalog.jsonb_build_object(
      'range', 'today',
      'timezone', 'UTC',
      'machine', ' all_cloud ',
      'tool', ' Codex ',
      'model', null
    ),
    null,
    50
  );
  v_canonical_query := v_result #> '{meta,query}';
  if v_canonical_query -> 'machines' <> '[]'::jsonb
     or v_canonical_query -> 'machine' <> 'null'::jsonb
     or v_canonical_query -> 'tools' <> '["Codex"]'::jsonb
     or v_canonical_query ->> 'tool' <> 'Codex'
     or v_canonical_query -> 'models' <> '[]'::jsonb
     or v_canonical_query -> 'model' <> 'null'::jsonb then
    raise exception 'legacy singular normalization/echo is incorrect: %', v_canonical_query;
  end if;

  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    pg_catalog.jsonb_build_object(
      'machines', pg_catalog.jsonb_build_array(' mac-one ', 'mac-one'),
      'machine', 'mac-one',
      'timezone', 'UTC'
    ),
    null,
    50
  );
  if v_result #> '{meta,query,machines}' <> '["mac-one"]'::jsonb
     or v_result #>> '{meta,query,machine}' <> 'mac-one' then
    raise exception 'equivalent plural/singular query was not canonicalized: %', v_result;
  end if;

  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    pg_catalog.jsonb_build_object(
      'machines', pg_catalog.jsonb_build_array('中', 'é', 'z'),
      'timezone', 'UTC'
    ),
    null,
    50
  );
  if v_result #> '{meta,query,machines}' <> '["z", "é", "中"]'::jsonb then
    raise exception 'unsigned UTF-8 byte ordering is incorrect: %', v_result #> '{meta,query,machines}';
  end if;

  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"machines":["mac-one"],"machine":"windows-one"}'::jsonb,
      null,
      50
    );
    raise exception 'plural/singular conflict unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"models":"gpt-5"}'::jsonb,
      null,
      50
    );
    raise exception 'non-array plural unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"tools":[" "]}'::jsonb,
      null,
      50
    );
    raise exception 'empty trimmed item unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"tools":[1]}'::jsonb,
      null,
      50
    );
    raise exception 'non-string array item unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      pg_catalog.jsonb_build_object('tools', pg_catalog.to_jsonb(pg_catalog.array_fill('x'::text, array[33]))),
      null,
      50
    );
    raise exception '33-item array unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      pg_catalog.jsonb_build_object('models', pg_catalog.jsonb_build_array(pg_catalog.repeat('é', 129))),
      null,
      50
    );
    raise exception 'over-budget UTF-8 item unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"machines":["all"]}'::jsonb,
      null,
      50
    );
    raise exception 'machine sentinel in plural unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      pg_catalog.jsonb_build_object('search', pg_catalog.repeat('x', 257)),
      null,
      50
    );
    raise exception 'over-budget search unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"tokenMode":"total"}'::jsonb,
      null,
      50
    );
    raise exception 'unsupported token mode unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;

  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"machines":["mac-one"],"tools":["Codex","Claude"],"timezone":"UTC"}'::jsonb,
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 2 then
    raise exception 'cross-dimension AND query is incorrect: %', v_result;
  end if;

  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"models":["gpt-5"],"tools":["Codex","Claude"],"search":"session-current","timezone":"UTC"}'::jsonb,
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 2
     or pg_catalog.jsonb_array_length(v_result #> '{availableFilters,models}') <> 2
     or pg_catalog.jsonb_array_length(v_result #> '{availableFilters,tools}') <> 1 then
    raise exception 'self-dimension facet exclusion is incorrect: %', v_result;
  end if;

  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"search":"%","timezone":"UTC"}'::jsonb,
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 1 then
    raise exception 'literal percent search is incorrect: %', v_result;
  end if;
  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"search":"_","timezone":"UTC"}'::jsonb,
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 1 then
    raise exception 'literal underscore search is incorrect: %', v_result;
  end if;
  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    pg_catalog.jsonb_build_object('search', pg_catalog.chr(92), 'timezone', 'UTC'),
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 1 then
    raise exception 'literal backslash search is incorrect: %', v_result;
  end if;
  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"search":"ascii-codex","timezone":"UTC"}'::jsonb,
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 1 then
    raise exception 'ASCII case-insensitive search is incorrect: %', v_result;
  end if;
  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"search":"模型A","timezone":"UTC"}'::jsonb,
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 1 then
    raise exception 'Unicode exact-case search is incorrect: %', v_result;
  end if;
  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"search":"模型a","timezone":"UTC"}'::jsonb,
    null,
    50
  );
  if (v_result ->> 'totalCount')::bigint <> 0 then
    raise exception 'Unicode search unexpectedly folded ASCII suffix case: %', v_result;
  end if;

  v_page_one := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"machines":["mac-one","windows-one"],"tools":["Codex","Claude"],"search":"session-current","timezone":"UTC"}'::jsonb,
    null,
    1
  );
  v_cursor := v_page_one ->> 'nextCursor';
  if v_cursor is null or v_cursor !~ '^v2\.[0-9a-f]+\.[0-9]+\.[0-9a-f]{32}$' then
    raise exception 'v2 cursor encoding is incorrect: %', v_cursor;
  end if;
  v_page_two := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"machines":[" windows-one ","mac-one","mac-one"],"tools":["Claude","Codex","Claude"],"search":"session-current","timezone":"UTC"}'::jsonb,
    v_cursor,
    1
  );
  if pg_catalog.jsonb_array_length(v_page_two -> 'items') <> 1 then
    raise exception 'canonical-equivalent cursor continuation failed: %', v_page_two;
  end if;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"machines":["mac-one","windows-one"],"tools":["Codex","Claude"],"search":"session-current-a","timezone":"UTC"}'::jsonb,
      v_cursor,
      1
    );
    raise exception 'search-changed cursor unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"machines":["mac-one"],"tools":["Codex","Claude"],"search":"session-current","timezone":"UTC"}'::jsonb,
      v_cursor,
      1
    );
    raise exception 'filter-changed cursor unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;

  v_entity := public.get_usage_entity_dashboard_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"machines":["mac-one"],"tools":["Codex"],"models":[],"search":"session-current","timezone":"UTC"}'::jsonb,
    '{"kind":" model ","id":" gpt-5 "}'::jsonb,
    null,
    1
  );
  if v_entity #> '{meta,entity}' <> '{"kind":"model","id":"gpt-5"}'::jsonb
     or v_entity #> '{historyPage,meta,entity}' <> '{"kind":"model","id":"gpt-5"}'::jsonb
     or (v_entity #>> '{summary,totalTokens}')::bigint <> 250 then
    raise exception 'entity query/echo is incorrect: %', v_entity;
  end if;
  v_cursor := v_entity #>> '{historyPage,nextCursor}';
  if v_cursor is null then
    raise exception 'entity history did not produce a bound cursor: %', v_entity;
  end if;
  begin
    perform public.get_usage_entity_dashboard_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"machines":["mac-one"],"tools":["Codex"],"models":[],"search":"session-current","timezone":"UTC"}'::jsonb,
      '{"kind":"model","id":"opus"}'::jsonb,
      v_cursor,
      1
    );
    raise exception 'entity-changed cursor unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.get_usage_entity_dashboard_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"models":["gpt-5"],"timezone":"UTC"}'::jsonb,
      '{"kind":"model","id":"gpt-5"}'::jsonb,
      null,
      1
    );
    raise exception 'entity with same-dimension query unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;

  v_query := '{"range":"today","timezone":"UTC","machines":["mac-one"],"tools":[],"models":["gpt-5"],"search":"session-current","tokenMode":"effective"}'::jsonb;
  v_dashboard := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111', v_query
  );
  v_comparison := public.get_usage_comparison_v2(
    '11111111-1111-1111-1111-111111111111', v_query
  );
  v_result := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111', v_query, null, 50
  );
  v_entity := public.get_usage_entity_dashboard_v2(
    '11111111-1111-1111-1111-111111111111',
    v_query,
    '{"kind":"tool","id":"Codex"}'::jsonb,
    null,
    20
  );
  v_canonical_query := v_dashboard #> '{meta,query}';
  if v_comparison #> '{meta,query}' <> v_canonical_query
     or v_result #> '{meta,query}' <> v_canonical_query
     or v_entity #> '{meta,query}' <> v_canonical_query then
    raise exception 'v2 surfaces do not share one canonical query: dashboard %, comparison %, details %, entity %',
      v_canonical_query,
      v_comparison #> '{meta,query}',
      v_result #> '{meta,query}',
      v_entity #> '{meta,query}';
  end if;
  if v_dashboard #>> '{meta,capabilities,multiFilterSearch}' <> 'true'
     or v_comparison #>> '{meta,capabilities,multiFilterSearch}' <> 'true'
     or v_result #>> '{meta,capabilities,multiFilterSearch}' <> 'true'
     or v_entity #>> '{meta,capabilities,multiFilterSearch}' <> 'true' then
    raise exception 'multiFilterSearch capability is not end-to-end: % / % / % / %',
      v_dashboard #> '{meta,capabilities}',
      v_comparison #> '{meta,capabilities}',
      v_result #> '{meta,capabilities}',
      v_entity #> '{meta,capabilities}';
  end if;

  v_week_comparison := public.get_usage_comparison_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"week","timezone":"UTC","machines":[],"tools":[],"models":[],"search":"session-current","tokenMode":"effective"}'::jsonb
  );
  if v_week_comparison #>> '{window,bucket}' <> 'day'
     or pg_catalog.jsonb_array_length(v_week_comparison #> '{current,series}') = 0
     or pg_catalog.jsonb_array_length(v_week_comparison #> '{previous,series}') = 0
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_week_comparison #> '{current,series}') as e(item)
       where e.item ->> 'bucket' !~ '^\d{4}-\d{2}-\d{2}$'
     )
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_week_comparison #> '{previous,series}') as e(item)
       where e.item ->> 'bucket' !~ '^\d{4}-\d{2}-\d{2}$'
     ) then
    raise exception 'day comparison buckets must use YYYY-MM-DD: %',
      v_week_comparison #> '{current,series}';
  end if;
  if (v_dashboard -> 'meta') ? 'entity'
     or v_entity #> '{meta,entity}' <> '{"kind":"tool","id":"Codex"}'::jsonb then
    raise exception 'ordinary/entity request identity echo is incorrect: % / %',
      v_dashboard -> 'meta', v_entity -> 'meta';
  end if;
  if (v_dashboard #>> '{summary,totalTokens}')::bigint <> 250
     or (v_comparison #>> '{current,summary,totalTokens}')::bigint <> 250
     or (v_result #>> '{filteredSummary,totalTokens}')::bigint <> 250
     or (v_entity #>> '{summary,totalTokens}')::bigint <> 250 then
    raise exception 'v2 surfaces applied different data predicates';
  end if;

  begin
    perform public.get_dashboard_stats_v2(
      '22222222-2222-2222-2222-222222222222', '{}'::jsonb
    );
    raise exception 'dashboard user mismatch unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_dashboard_stats_v2(null, '{}'::jsonb);
    raise exception 'null p_user unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_usage_comparison_v2(
      '22222222-2222-2222-2222-222222222222', '{}'::jsonb
    );
    raise exception 'comparison user mismatch unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_usage_details_v2(
      '22222222-2222-2222-2222-222222222222', '{}'::jsonb, null, 50
    );
    raise exception 'details user mismatch unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_usage_entity_dashboard_v2(
      '22222222-2222-2222-2222-222222222222',
      '{}'::jsonb,
      '{"kind":"tool","id":"Codex"}'::jsonb,
      null,
      20
    );
    raise exception 'entity user mismatch unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;

-- T10.88 uses dedicated, query-selectable rows so assertions do not depend on
-- the order or totals of the established regression fixtures above.
with fixture_time as (
  select pg_catalog.to_char(
    greatest(
      pg_catalog.now() at time zone 'UTC' - interval '20 minutes',
      pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC')
    ),
    'YYYY-MM-DD HH24:MI:SS'
  ) as timestamp
)
insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, timestamp, session_id, unique_key, cost_usd,
  machine_id, requests
)
select
  v.user_id::uuid,
  v.tool,
  v.model,
  v.input_tokens,
  v.output_tokens,
  v.cached_tokens,
  v.cache_write_tokens,
  f.timestamp,
  v.session_id,
  v.unique_key,
  v.cost_usd,
  v.machine_id,
  1
from fixture_time f
cross join (values
  -- True zero cost and the only logically certain zero/zero cache split.
  ('11111111-1111-1111-1111-111111111111', 'ProvKnownZero', 'known-zero-model',
    10::bigint, 5::bigint, 0::bigint, 0::bigint,
    'prov-known-zero', 'stats-v2-prov-known-zero', 0::double precision, 'prov-zero-machine'),
  -- Historical bare zero: cached>0/write=0 cannot prove a write-free split.
  ('11111111-1111-1111-1111-111111111111', 'ProvHistoricalZero', 'historical-zero-model',
    10::bigint, 5::bigint, 70::bigint, 0::bigint,
    'prov-historical-zero', 'stats-v2-prov-historical-zero', 0.1::double precision, 'prov-historical-machine'),
  -- Positive write plus a zero-cache/zero-write row is a complete split.
  ('11111111-1111-1111-1111-111111111111', 'ProvExplicit', 'explicit-model',
    10::bigint, 5::bigint, 100::bigint, 20::bigint,
    'prov-explicit-write', 'stats-v2-prov-explicit-write', 0.25::double precision, 'prov-explicit-machine'),
  ('11111111-1111-1111-1111-111111111111', 'ProvExplicit', 'explicit-model',
    20::bigint, 5::bigint, 0::bigint, 0::bigint,
    'prov-explicit-zero', 'stats-v2-prov-explicit-zero', 0.05::double precision, 'prov-explicit-machine'),
  -- One historical zero and one unknown cost poison only optional provenance.
  ('11111111-1111-1111-1111-111111111111', 'ProvMixed', 'mixed-model',
    10::bigint, 5::bigint, 100::bigint, 20::bigint,
    'prov-mixed-known', 'stats-v2-prov-mixed-known', 0.25::double precision, 'prov-mixed-machine'),
  ('11111111-1111-1111-1111-111111111111', 'ProvMixed', 'mixed-model',
    20::bigint, 5::bigint, 40::bigint, 0::bigint,
    'prov-mixed-unknown', 'stats-v2-prov-mixed-unknown', null::double precision, 'prov-mixed-machine'),
  -- Invalid cache components must also stay combined-only.
  ('11111111-1111-1111-1111-111111111111', 'ProvNegativeWrite', 'negative-write-model',
    10::bigint, 5::bigint, 10::bigint, (-1)::bigint,
    'prov-negative-write', 'stats-v2-prov-negative-write', 0.1::double precision, 'prov-negative-machine'),
  ('11111111-1111-1111-1111-111111111111', 'ProvHighWrite', 'high-write-model',
    10::bigint, 5::bigint, 10::bigint, 11::bigint,
    'prov-high-write', 'stats-v2-prov-high-write', 0.1::double precision, 'prov-high-machine'),
  -- The extreme model total exceeds float8. Interleaved balancing rows keep
  -- required summary/tool/machine aggregates representable and non-negative.
  ('11111111-1111-1111-1111-111111111111', 'ProvExtremeA', 'extreme-model',
    10::bigint, 5::bigint, 0::bigint, 0::bigint,
    'prov-extreme-a', 'stats-v2-prov-extreme-a', 1e308::double precision, 'prov-extreme-machine-a'),
  ('11111111-1111-1111-1111-111111111111', 'ProvExtremeA', 'extreme-balancer',
    10::bigint, 5::bigint, 0::bigint, 0::bigint,
    'prov-extreme-balance', 'stats-v2-prov-extreme-balance', (-1e308)::double precision, 'prov-extreme-machine-a'),
  ('11111111-1111-1111-1111-111111111111', 'ProvExtremeB', 'extreme-model',
    10::bigint, 5::bigint, 0::bigint, 0::bigint,
    'prov-extreme-b', 'stats-v2-prov-extreme-b', 1e308::double precision, 'prov-extreme-machine-b'),
  -- Same selector owned by another user must never enter user one's scope.
  ('22222222-2222-2222-2222-222222222222', 'ProvMixed', 'mixed-model',
    9000::bigint, 1000::bigint, 500::bigint, 100::bigint,
    'prov-other-owner', 'stats-v2-prov-other-owner', 99::double precision, 'prov-mixed-machine')
) as v(
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, session_id, unique_key, cost_usd, machine_id
);

-- Omitting cache_write_tokens after this migration must store SQL NULL rather
-- than replaying the historical default zero.
with fixture_time as (
  select pg_catalog.to_char(
    greatest(
      pg_catalog.now() at time zone 'UTC' - interval '20 minutes',
      pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC')
    ),
    'YYYY-MM-DD HH24:MI:SS'
  ) as timestamp
)
insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  timestamp, session_id, unique_key, cost_usd, machine_id, requests
)
select
  '11111111-1111-1111-1111-111111111111',
  'ProvOmitted',
  'omitted-write-model',
  10,
  5,
  60,
  f.timestamp,
  'prov-omitted-write',
  'stats-v2-prov-omitted-write',
  null,
  'prov-omitted-machine',
  1
from fixture_time f;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_query jsonb;
  v_dashboard jsonb;
  v_details jsonb;
  v_comparison jsonb;
  v_entity jsonb;
  v_machine jsonb;
  v_item jsonb;
  v_tool text;
begin
  if (
    select t.cache_write_tokens is not null
    from public.token_logs t
    where t.unique_key = 'stats-v2-prov-omitted-write'
  ) then
    raise exception 'omitted cache_write_tokens did not remain SQL null';
  end if;

  v_query := '{"range":"today","timezone":"UTC","machines":[],"tools":["ProvKnownZero"],"models":[],"search":null,"tokenMode":"effective"}'::jsonb;
  v_dashboard := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111', v_query
  );
  if pg_catalog.jsonb_typeof(v_dashboard #> '{summary,totalCost}') <> 'number'
     or (v_dashboard #>> '{summary,totalCost}')::double precision <> 0
     or not (v_dashboard #> '{models,known-zero-model}') ? 'cost'
     or (v_dashboard #>> '{models,known-zero-model,cost}')::double precision <> 0
     or (v_dashboard #>> '{summary,cacheReadTokens}')::bigint <> 0
     or (v_dashboard #>> '{summary,cacheWriteTokens}')::bigint <> 0
     or (v_dashboard #>> '{models,known-zero-model,cacheRead}')::bigint <> 0
     or (v_dashboard #>> '{models,known-zero-model,cacheWrite}')::bigint <> 0 then
    raise exception 'true zero cost or zero/zero cache fact was lost: %', v_dashboard;
  end if;

  v_query := '{"range":"today","timezone":"UTC","machines":[],"tools":["ProvExplicit"],"models":[],"search":null,"tokenMode":"effective"}'::jsonb;
  v_dashboard := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111', v_query
  );
  select item into v_machine
  from pg_catalog.jsonb_array_elements(v_dashboard -> 'machineDistribution') as e(item)
  where item ->> 'value' = 'prov-explicit-machine';
  if v_machine is null then
    raise exception 'machineDistribution entry for prov-explicit-machine is missing: %', v_dashboard;
  end if;
  if (v_dashboard #>> '{summary,cachedTokens}')::bigint <> 100
     or (v_dashboard #>> '{summary,cacheReadTokens}')::bigint <> 80
     or (v_dashboard #>> '{summary,cacheWriteTokens}')::bigint <> 20
     or (v_dashboard #>> '{tools,ProvExplicit,cacheRead}')::bigint <> 80
     or (v_dashboard #>> '{tools,ProvExplicit,cacheWrite}')::bigint <> 20
     or (v_dashboard #>> '{models,explicit-model,cacheRead}')::bigint <> 80
     or (v_dashboard #>> '{models,explicit-model,cacheWrite}')::bigint <> 20
     or (v_machine ->> 'cacheReadTokens')::bigint <> 80
     or (v_machine ->> 'cacheWriteTokens')::bigint <> 20 then
    raise exception 'explicit positive cache write was not preserved: %', v_dashboard;
  end if;

  foreach v_tool in array array[
    'ProvHistoricalZero',
    'ProvOmitted',
    'ProvNegativeWrite',
    'ProvHighWrite',
    'ProvMixed'
  ]
  loop
    v_query := pg_catalog.jsonb_build_object(
      'range', 'today',
      'timezone', 'UTC',
      'machines', '[]'::jsonb,
      'tools', pg_catalog.jsonb_build_array(v_tool),
      'models', '[]'::jsonb,
      'search', null,
      'tokenMode', 'effective'
    );
    v_dashboard := public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111', v_query
    );
    select item into v_machine
    from pg_catalog.jsonb_array_elements(v_dashboard -> 'machineDistribution') as e(item)
    limit 1;
    if v_machine is null then
      raise exception 'machineDistribution is missing for %: %', v_tool, v_dashboard;
    end if;
    if (v_dashboard -> 'summary') ? 'cacheReadTokens'
       or (v_dashboard -> 'summary') ? 'cacheWriteTokens'
       or (v_dashboard #> array['tools', v_tool]) ? 'cacheRead'
       or (v_dashboard #> array['tools', v_tool]) ? 'cacheWrite'
       or exists (
         select 1
         from pg_catalog.jsonb_each(v_dashboard -> 'models') as m(key, value)
         where m.value ? 'cacheRead' or m.value ? 'cacheWrite'
       )
       or v_machine ? 'cacheReadTokens'
       or v_machine ? 'cacheWriteTokens' then
      raise exception 'unproven cache split leaked for %: %', v_tool, v_dashboard;
    end if;
  end loop;

  v_query := '{"range":"today","timezone":"UTC","machines":[],"tools":["ProvMixed"],"models":[],"search":null,"tokenMode":"effective"}'::jsonb;
  v_dashboard := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111', v_query
  );
  select item into v_machine
  from pg_catalog.jsonb_array_elements(v_dashboard -> 'machineDistribution') as e(item)
  where item ->> 'value' = 'prov-mixed-machine';
  if (v_dashboard #>> '{summary,totalTokens}')::bigint <> 40
     or (v_dashboard #>> '{summary,cachedTokens}')::bigint <> 140
     or pg_catalog.jsonb_typeof(v_dashboard #> '{summary,totalCost}') <> 'number'
     or pg_catalog.jsonb_typeof(v_dashboard #> '{tools,ProvMixed,cost}') <> 'number'
     or (v_dashboard #> '{models,mixed-model}') ? 'cost'
     or pg_catalog.jsonb_typeof(v_machine -> 'cost') <> 'number' then
    raise exception 'mixed provenance changed required dashboard fields: %', v_dashboard;
  end if;

  v_details := public.get_usage_details_v2(
    '11111111-1111-1111-1111-111111111111', v_query, null, 50
  );
  if (v_details ->> 'totalCount')::bigint <> 2
     or (v_details #>> '{filteredSummary,totalTokens}')::bigint <> 40
     or pg_catalog.jsonb_typeof(v_details #> '{filteredSummary,totalCost}') <> 'number'
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_details -> 'items') as e(item)
       where pg_catalog.jsonb_typeof(e.item -> 'cost') <> 'number'
     ) then
    raise exception 'details behavior or owner boundary changed: %', v_details;
  end if;

  v_comparison := public.get_usage_comparison_v2(
    '11111111-1111-1111-1111-111111111111', v_query
  );
  if pg_catalog.jsonb_typeof(v_comparison #> '{current,summary,totalCost}') <> 'number'
     or pg_catalog.jsonb_typeof(v_comparison #> '{previous,summary,totalCost}') <> 'number'
     or pg_catalog.jsonb_typeof(v_comparison #> '{delta,cost}') <> 'object'
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_comparison #> '{current,series}') as e(item)
       where pg_catalog.jsonb_typeof(e.item -> 'cost') <> 'number'
     ) then
    raise exception 'comparison required cost shape changed: %', v_comparison;
  end if;

  v_entity := public.get_usage_entity_dashboard_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"today","timezone":"UTC","machines":[],"tools":[],"models":[],"search":null,"tokenMode":"effective"}'::jsonb,
    '{"kind":"tool","id":"ProvMixed"}'::jsonb,
    null,
    20
  );
  if pg_catalog.jsonb_typeof(v_entity #> '{summary,totalCost}') <> 'number'
     or pg_catalog.jsonb_typeof(v_entity #> '{peak,cost}') <> 'number'
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_entity #> '{composition,models}') as e(item)
       where pg_catalog.jsonb_typeof(e.item -> 'cost') <> 'number'
     ) then
    raise exception 'entity required cost shape changed: %', v_entity;
  end if;

  -- Two finite 1e308 rows overflow float8 when grouped by model. The public
  -- RPC must succeed and omit only that optional model cost.
  v_query := '{"range":"today","timezone":"UTC","machines":[],"tools":["ProvExtremeA","ProvExtremeB"],"models":[],"search":null,"tokenMode":"effective"}'::jsonb;
  v_dashboard := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111', v_query
  );
  if (v_dashboard #> '{models,extreme-model}') ? 'cost'
     or (v_dashboard #> '{models,extreme-balancer}') ? 'cost'
     or pg_catalog.jsonb_typeof(v_dashboard #> '{summary,totalCost}') <> 'number'
     or exists (
       select 1
       from pg_catalog.jsonb_each(v_dashboard -> 'tools') as t(key, value)
       where pg_catalog.jsonb_typeof(t.value -> 'cost') <> 'number'
     )
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(v_dashboard -> 'machineDistribution') as e(item)
       where pg_catalog.jsonb_typeof(e.item -> 'cost') <> 'number'
     ) then
    raise exception 'extreme finite model cost was not safely omitted: %', v_dashboard;
  end if;
end;
$$;

reset role;

-- T10.118b daily-cost fixtures stay query-isolated by tool so pathological
-- required legacy cost aggregates cannot mask another reason assertion.
insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, timestamp, session_id, unique_key, cost_usd,
  machine_id, requests
) values
  ('11111111-1111-1111-1111-111111111111', 'DailyGood', 'daily-good', 10, 5, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-good-a', 'daily-good-a', 0.125, 'daily-mac-a', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyGood', 'daily-good', 0, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-good-zero-token', 'daily-good-zero-token', 0.375, 'daily-mac-a', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyMissing', 'daily-missing', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-missing', 'daily-missing', null, 'daily-mac-b', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyZero', 'daily-zero', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-zero', 'daily-zero', 0, 'daily-mac-c', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyNegative', 'daily-negative', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-negative', 'daily-negative', -0.5, 'daily-mac-d', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyNaN', 'daily-nan', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-nan', 'daily-nan', 'NaN'::double precision, 'daily-mac-e', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyInfinity', 'daily-infinity', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-infinity', 'daily-infinity', 'Infinity'::double precision, 'daily-mac-f', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyNegativeInfinity', 'daily-negative-infinity', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-negative-infinity', 'daily-negative-infinity', '-Infinity'::double precision, 'daily-mac-f2', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyMixed', 'daily-mixed', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-mixed-missing', 'daily-mixed-missing', null, 'daily-mac-g', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyMixed', 'daily-mixed', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-mixed-invalid', 'daily-mixed-invalid', -1, 'daily-mac-g', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyMixed', 'daily-mixed', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-mixed-zero', 'daily-mixed-zero', 0, 'daily-mac-g', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyInactive', 'daily-inactive', 0, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-inactive', 'daily-inactive', null, 'daily-mac-h', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyInvalidZero', 'daily-invalid-zero', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-invalid-zero-negative', 'daily-invalid-zero-negative', -0.1, 'daily-mac-i', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyInvalidZero', 'daily-invalid-zero', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-invalid-zero-zero', 'daily-invalid-zero-zero', 0, 'daily-mac-i', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyZeroTokenMissing', 'daily-zero-token-missing', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-zero-token-positive', 'daily-zero-token-positive', 0.2, 'daily-mac-j', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyZeroTokenMissing', 'daily-zero-token-missing', 0, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-zero-token-null', 'daily-zero-token-null', null, 'daily-mac-j', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyFilter', 'filter-model-a', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'filter-hit-a', 'daily-filter-a', 0.1, 'filter-machine-a', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyFilter', 'filter-model-a', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'filter-hit-b', 'daily-filter-b', 0.2, 'filter-machine-b', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyFilter', 'filter-model-b', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'filter-hit-c', 'daily-filter-c', 0.3, 'filter-machine-a', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyFilter', 'filter-model-a', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'filter-miss', 'daily-filter-d', 0.4, 'filter-machine-a', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyArchive', 'daily-archive', 1, 0, 0, 0,
   '2024-01-02 12:00:00', 'daily-archive-2024', 'daily-archive-2024', 0.01, 'daily-archive-mac', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyArchive', 'daily-archive', 1, 0, 0, 0,
   '2025-06-03 12:00:00', 'daily-archive-2025', 'daily-archive-2025', 0.02, 'daily-archive-mac', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyArchive', 'daily-archive', 1, 0, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-archive-current', 'daily-archive-current', 0.03, 'daily-archive-mac', 1),
  ('22222222-2222-2222-2222-222222222222', 'DailyGood', 'daily-good', 999, 1, 0, 0,
   to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'daily-other-user', 'daily-other-user', 99, 'daily-mac-other', 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_today date := (pg_catalog.now() at time zone 'UTC')::date;
  v_result jsonb;
  v_day jsonb;
  v_range text;
  v_expected_start date;
  v_tool text;
  v_reason text;
begin
  v_result := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"today","timezone":"UTC","machines":["daily-mac-a"],"tools":["DailyGood"],"models":["daily-good"],"search":"daily-good","tokenMode":"effective"}'::jsonb
  );
  v_day := v_result #> '{dailyCosts,days,0}';
  if v_result #> '{dailyCosts,coverage}' <> pg_catalog.jsonb_build_object(
       'start', v_today::text, 'end', v_today::text,
       'timezone', 'UTC', 'state', 'complete'
     )
     or pg_catalog.jsonb_array_length(v_result #> '{dailyCosts,days}') is distinct from 1
     or v_day ->> 'date' is distinct from v_today::text
     or v_day ->> 'status' is distinct from 'recorded-estimate'
     or v_day ? 'reason'
     or (v_day ->> 'amountUsd')::double precision is distinct from 0.5 then
    raise exception 'daily recorded estimate/zero-token completeness/filtering mismatch: %',
      v_result -> 'dailyCosts';
  end if;

  for v_tool, v_reason in
    select * from (values
      ('DailyMissing', 'missing-cost'),
      ('DailyZero', 'legacy-zero'),
      ('DailyNegative', 'invalid-cost'),
      ('DailyNaN', 'invalid-cost'),
      ('DailyInfinity', 'invalid-cost'),
      ('DailyNegativeInfinity', 'invalid-cost'),
      ('DailyMixed', 'missing-cost'),
      ('DailyInvalidZero', 'invalid-cost'),
      ('DailyZeroTokenMissing', 'missing-cost')
    ) as expected(tool, reason)
  loop
    v_result := public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      pg_catalog.jsonb_build_object(
        'range', 'today', 'timezone', 'UTC', 'machines', '[]'::jsonb,
        'tools', pg_catalog.jsonb_build_array(v_tool), 'models', '[]'::jsonb,
        'search', null, 'tokenMode', 'effective'
      )
    );
    v_day := v_result #> '{dailyCosts,days,0}';
    if pg_catalog.jsonb_array_length(v_result #> '{dailyCosts,days}') is distinct from 1
       or v_day ->> 'status' is distinct from 'unavailable'
       or v_day ->> 'reason' is distinct from v_reason
       or pg_catalog.jsonb_typeof(v_day -> 'amountUsd') is distinct from 'null' then
      raise exception 'daily unavailable reason mismatch for %/%: %',
        v_tool, v_reason, v_result -> 'dailyCosts';
    end if;
  end loop;

  v_result := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"today","timezone":"UTC","tools":["DailyInactive"]}'::jsonb
  );
  if v_result #> '{dailyCosts,days}' <> '[]'::jsonb then
    raise exception 'zero-effective-token day must be omitted: %', v_result -> 'dailyCosts';
  end if;

  foreach v_result in array array[
    public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"range":"today","timezone":"UTC","machines":["filter-machine-a"],"tools":["DailyFilter"]}'::jsonb
    ),
    public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"range":"today","timezone":"UTC","tools":["DailyFilter"],"models":["filter-model-a"]}'::jsonb
    ),
    public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"range":"today","timezone":"UTC","tools":["DailyFilter"],"search":"filter-hit"}'::jsonb
    )
  ] loop
    if (v_result #>> '{dailyCosts,days,0,amountUsd}')::double precision
         is distinct from (case
           when v_result #> '{meta,query,machines}' <> '[]'::jsonb then 0.8
           when v_result #> '{meta,query,models}' <> '[]'::jsonb then 0.7
           else 0.6
         end) then
      raise exception 'one-dimensional daily filter leaked excluded rows: %', v_result;
    end if;
  end loop;

  for v_range, v_expected_start in
    select * from (values
      ('today', v_today),
      ('week', pg_catalog.date_trunc('week', v_today::timestamp)::date),
      ('month', pg_catalog.date_trunc('month', v_today::timestamp)::date),
      ('year', pg_catalog.date_trunc('year', v_today::timestamp)::date)
    ) as expected(range_name, start_date)
  loop
    v_result := public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      pg_catalog.jsonb_build_object(
        'range', v_range, 'timezone', 'UTC',
        'tools', pg_catalog.jsonb_build_array('DailyGood')
      )
    );
    if v_result #>> '{dailyCosts,coverage,start}' is distinct from v_expected_start::text
       or v_result #>> '{dailyCosts,coverage,end}' is distinct from v_today::text then
      raise exception 'daily preset coverage mismatch for %: %',
        v_range, v_result #> '{dailyCosts,coverage}';
    end if;
  end loop;

  v_result := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"all","timezone":"UTC","tools":["NoSuchDailyTool"]}'::jsonb
  );
  if v_result #> '{dailyCosts,coverage,start}' <> 'null'::jsonb
     or v_result #>> '{dailyCosts,coverage,end}' is distinct from v_today::text
     or v_result #> '{dailyCosts,days}' <> '[]'::jsonb then
    raise exception 'daily all empty coverage mismatch: %', v_result -> 'dailyCosts';
  end if;

  v_result := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"all","timezone":"UTC","tools":["DailyArchive"]}'::jsonb
  );
  if pg_catalog.jsonb_array_length(v_result #> '{dailyCosts,days}') is distinct from 3
     or v_result #>> '{dailyCosts,days,0,date}' is distinct from '2024-01-02'
     or v_result #>> '{dailyCosts,days,1,date}' is distinct from '2025-06-03'
     or v_result #>> '{dailyCosts,days,2,date}' is distinct from v_today::text
     or pg_catalog.octet_length((v_result -> 'dailyCosts')::text) > 1048576 then
    raise exception 'multi-year all daily response was truncated, unsorted, or over budget: %',
      v_result -> 'dailyCosts';
  end if;

  begin
    perform public.get_dashboard_stats_v2(
      '22222222-2222-2222-2222-222222222222',
      '{"range":"today","timezone":"UTC","tools":["DailyGood"]}'::jsonb
    );
    raise exception 'cross-user daily dashboard unexpectedly succeeded';
  exception when sqlstate '42501' then null;
  end;
end;
$$;

reset role;

-- A bounded three-year active-day fixture measures payload growth by days,
-- in addition to the existing 100k-row throughput fixture concentrated in hours.
insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, timestamp, session_id, unique_key, cost_usd,
  machine_id, requests
)
select
  '11111111-1111-1111-1111-111111111111'::uuid,
  'DailyArchiveDense', 'daily-archive-dense', 1, 0, 0, 0,
  to_char(d, 'YYYY-MM-DD HH24:MI:SS'),
  'daily-dense-' || to_char(d, 'YYYY-MM-DD'),
  'daily-dense-' || to_char(d, 'YYYY-MM-DD'), 0.001, 'daily-dense-mac', 1
from pg_catalog.generate_series(
  date_trunc('day', now() at time zone 'UTC') - interval '3 years',
  date_trunc('day', now() at time zone 'UTC') - interval '1 day',
  interval '1 day'
) as d;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  v_result jsonb;
  v_expected integer;
  v_actual integer;
  v_bytes integer;
  v_dates text[];
  v_sorted text[];
begin
  select count(*) into v_expected
  from pg_catalog.generate_series(
    date_trunc('day', now() at time zone 'UTC') - interval '3 years',
    date_trunc('day', now() at time zone 'UTC') - interval '1 day',
    interval '1 day'
  );
  v_result := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    '{"range":"all","timezone":"UTC","tools":["DailyArchiveDense"]}'::jsonb
  );
  v_actual := pg_catalog.jsonb_array_length(v_result #> '{dailyCosts,days}');
  v_bytes := pg_catalog.octet_length(v_result::text);
  select array_agg(e.item ->> 'date' order by e.ordinality),
         array_agg(e.item ->> 'date' order by e.item ->> 'date')
    into v_dates, v_sorted
  from pg_catalog.jsonb_array_elements(v_result #> '{dailyCosts,days}') with ordinality as e(item, ordinality);
  if v_actual is distinct from v_expected or v_dates is distinct from v_sorted
    or v_bytes > 1048576
    or v_result #>> '{dailyCosts,coverage,state}' is distinct from 'complete' then
    raise exception 'all daily coverage/payload was truncated, unordered or over budget: %/% days, % bytes',
      v_actual, v_expected, v_bytes;
  end if;
  raise notice 'T10.118b all coverage: % active days, % full-response bytes', v_actual, v_bytes;
end;
$$;
reset role;

-- Both the wrapper and the frozen base compare the wall-clock text column to
-- one transaction-stable local now. UTC and Etc/GMT+12 are twelve wall-clock
-- hours apart, so one is always safely within 06:00..17:59; choose it and put
-- rows two hours before/after the exact cutoff on the same local calendar day.
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  v_timezone text;
  v_local_now timestamp;
  v_local_date date;
  v_past timestamp;
  v_future timestamp;
  v_today_result jsonb;
  v_custom_result jsonb;
  v_result jsonb;
begin
  v_timezone := case
    when extract(hour from pg_catalog.transaction_timestamp() at time zone 'UTC')
      between 6 and 17 then 'UTC'
    else 'Etc/GMT+12'
  end;

  v_local_now := pg_catalog.transaction_timestamp() at time zone v_timezone;
  v_local_date := v_local_now::date;
  v_past := v_local_now - interval '2 hours';
  v_future := v_local_now + interval '2 hours';
  if v_past::date is distinct from v_local_date
     or v_future::date is distinct from v_local_date
     or not (v_future > v_local_now) then
    raise exception 'cutoff fixture is not same-day future data: % / % / %',
      v_past, v_local_now, v_future;
  end if;

  insert into public.token_logs (
    user_id, tool, model, input_tokens, output_tokens, cached_tokens,
    cache_write_tokens, timestamp, session_id, unique_key, cost_usd,
    machine_id, requests
  ) values
    ('11111111-1111-1111-1111-111111111111', 'DailyNowCutoff', 'daily-now-cutoff',
     7, 0, 0, 0, pg_catalog.to_char(v_past, 'YYYY-MM-DD HH24:MI:SS'),
     'daily-now-past', 'daily-now-past', 0.7, 'daily-now-mac', 1),
    ('11111111-1111-1111-1111-111111111111', 'DailyNowCutoff', 'daily-now-cutoff',
     90, 0, 0, 0, pg_catalog.to_char(v_future, 'YYYY-MM-DD HH24:MI:SS'),
     'daily-now-future', 'daily-now-future', 9.0, 'daily-now-mac', 1);

  if not exists (
    select 1
    from public.token_logs t
    where t.user_id = '11111111-1111-1111-1111-111111111111'
      and t.unique_key = 'daily-now-future'
      and t.timestamp::timestamp > (
        pg_catalog.transaction_timestamp() at time zone v_timezone
      )
      and t.timestamp::timestamp::date = v_local_date
  ) then
    raise exception 'future cutoff row is not strictly after transaction now on the same local day';
  end if;

  v_today_result := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    pg_catalog.jsonb_build_object(
      'range', 'today', 'timezone', v_timezone,
      'tools', pg_catalog.jsonb_build_array('DailyNowCutoff')
    )
  );
  v_custom_result := public.get_dashboard_stats_v2(
    '11111111-1111-1111-1111-111111111111',
    pg_catalog.jsonb_build_object(
      'range', 'custom', 'start', v_local_date, 'end', v_local_date + 30,
      'timezone', v_timezone,
      'tools', pg_catalog.jsonb_build_array('DailyNowCutoff')
    )
  );

  foreach v_result in array array[v_today_result, v_custom_result]
  loop
    if (v_result #>> '{summary,totalTokens}')::bigint is distinct from 7
       or (v_result #>> '{summary,totalCost}')::double precision is distinct from 0.7
       or pg_catalog.jsonb_array_length(v_result #> '{dailyCosts,days}') is distinct from 1
       or v_result #>> '{dailyCosts,days,0,status}' is distinct from 'recorded-estimate'
       or v_result #>> '{dailyCosts,days,0,date}' is distinct from v_local_date::text
       or (v_result #>> '{dailyCosts,days,0,amountUsd}')::double precision
         is distinct from 0.7 then
      raise exception 'transaction-now cutoff included future row: %', v_result;
    end if;
    raise notice 'T10.118b exact-now cutoff: range=%, timezone=%, future=% excluded, tokens=7, cost=0.7',
      v_result #>> '{meta,query,range}', v_timezone, v_future;
  end loop;
end;
$$;
reset role;

-- First prove the real RPC retains its required float8 overflow failure.
-- Only afterward isolate the daily numeric guard using a temporary valid
-- legacy base; restore its exact pg_get_functiondef on both paths.
insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, timestamp, session_id, unique_key, cost_usd,
  machine_id, requests
) values
  ('11111111-1111-1111-1111-111111111111', 'DailyOverflow', 'daily-overflow',
   1, 0, 0, 0, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
   'daily-overflow-a', 'daily-overflow-a', 1e308, 'daily-overflow-mac', 1),
  ('11111111-1111-1111-1111-111111111111', 'DailyOverflow', 'daily-overflow',
   1, 0, 0, 0, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
   'daily-overflow-b', 'daily-overflow-b', 1e308, 'daily-overflow-mac', 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  v_error_message text;
begin
  begin
    perform public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"range":"today","timezone":"UTC","tools":["DailyOverflow"]}'::jsonb
    );
    raise exception 'real dashboard unexpectedly accepted required float8 overflow';
  exception when sqlstate '22003' then
    get stacked diagnostics v_error_message = message_text;
    raise notice 'T10.118b expected real RPC failure: SQLSTATE 22003, message=%', v_error_message;
  end;
end;
$$;
reset role;

do $$
declare
  v_original_definition text;
  v_result jsonb;
  v_error text;
begin
  select pg_catalog.pg_get_functiondef(
    'private.get_dashboard_stats_v2_base_t63(uuid,jsonb)'::pg_catalog.regprocedure
  ) into v_original_definition;
  begin
    execute $stub$
      create or replace function private.get_dashboard_stats_v2_base_t63(
        p_user uuid,
        p_query jsonb
      )
      returns jsonb
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select '{"summary":{"totalTokens":0,"inputTokens":0,"outputTokens":0,"cachedTokens":0,"totalCost":0,"totalRequests":0,"avgTokensPerReq":0},"tools":{},"models":{},"trends":[],"heatmap":{},"history":[],"machineDistribution":[]}'::jsonb
      $body$
    $stub$;

    perform pg_catalog.set_config(
      'request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true
    );
    perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
    -- This branch-isolation evidence validates dailyCosts numeric guarding;
    -- it does not claim that the production RPC succeeds for these rows.
    v_result := public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"range":"today","timezone":"UTC","tools":["DailyOverflow"]}'::jsonb
    );
    if v_result #>> '{dailyCosts,days,0,status}' is distinct from 'unavailable'
       or v_result #>> '{dailyCosts,days,0,reason}' is distinct from 'invalid-cost'
       or pg_catalog.jsonb_typeof(v_result #> '{dailyCosts,days,0,amountUsd}')
         is distinct from 'null' then
      raise exception 'numeric overflow was not classified by the public wrapper: %',
        v_result -> 'dailyCosts';
    end if;
    execute v_original_definition;
    raise notice 'T10.118b branch-isolation only: numeric guard classified invalid-cost; original base restored, production RPC success not asserted';
  exception when others then
    get stacked diagnostics v_error = message_text;
    execute v_original_definition;
    raise exception 'overflow isolation failed after restoring dashboard base: %', v_error;
  end;
end;
$$;

delete from public.token_logs
where user_id = '11111111-1111-1111-1111-111111111111'
  and tool = 'DailyOverflow';

-- The 100k-row block keeps performance evidence reproducible and is rolled
-- back with the rest of this file. The first plan covers fully scoped keyset
-- details; the second proves literal search stays inside a user/time candidate
-- scan instead of weakening the authorization predicate.
insert into public.token_logs (
  user_id,
  tool,
  model,
  input_tokens,
  output_tokens,
  cached_tokens,
  cache_write_tokens,
  timestamp,
  session_id,
  unique_key,
  cost_usd,
  machine_id,
  requests
)
select
  '11111111-1111-1111-1111-111111111111'::uuid,
  'PerfTool-' || (g % 4)::text,
  'PerfModel-' || (g % 8)::text,
  10,
  5,
  2,
  1,
  to_char(
    now() at time zone 'UTC' - ((g % 7200)::text || ' seconds')::interval,
    'YYYY-MM-DD HH24:MI:SS'
  ),
  'perf-session-' || g::text,
  'stats-v2-perf-' || g::text,
  0.001,
  'perf-mac-' || (g % 16)::text,
  1
from pg_catalog.generate_series(1, 100000) as g;

analyze public.token_logs;

explain (analyze, buffers, costs, timing, summary)
select t.id, t.timestamp
from public.token_logs t
where t.user_id = '11111111-1111-1111-1111-111111111111'
  and t.machine_id = 'perf-mac-1'
  and t.tool = 'PerfTool-1'
  and t.model = 'PerfModel-1'
order by t.timestamp desc, t.id desc
limit 51;

explain (analyze, buffers, costs, timing, summary)
select t.id, t.timestamp
from public.token_logs t
where t.user_id = '11111111-1111-1111-1111-111111111111'
  and t.timestamp >= to_char(
    now() at time zone 'UTC' - interval '2 hours',
    'YYYY-MM-DD HH24:MI:SS'
  )
  and private.tokenledger_search_match_v2(
    'perf-session-9999', t.tool, t.model, t.machine_id, t.session_id
  )
order by t.timestamp desc, t.id desc
limit 51;

-- T10.88 cache provenance is a single grouped pass over the filtered rows.
-- The EXPLAIN is intentionally adjacent to the existing 100k plans so a
-- replay produces evidence that adding provenance does not fan out into
-- per-tool/model/machine table scans.
explain (analyze, buffers, costs, timing, summary)
with filtered as materialized (
  select t.tool, t.model, t.machine_id, t.cached_tokens, t.cache_write_tokens
  from public.token_logs t
  where t.user_id = '11111111-1111-1111-1111-111111111111'
    and t.timestamp >= to_char(
      now() at time zone 'UTC' - interval '2 hours',
      'YYYY-MM-DD HH24:MI:SS'
    )
    and private.tokenledger_search_match_v2(
      'perf-session-9999', t.tool, t.model, t.machine_id, t.session_id
    )
)
select
  pg_catalog.count(*)::bigint as row_count,
  pg_catalog.sum(f.cached_tokens)::bigint as cached_tokens,
  pg_catalog.sum(coalesce(f.cache_write_tokens, 0))::bigint as cache_write_tokens,
  pg_catalog.bool_and(
    f.cached_tokens >= 0
    and f.cache_write_tokens is not null
    and f.cache_write_tokens >= 0
    and f.cache_write_tokens <= f.cached_tokens
    and (
      (f.cached_tokens = 0 and f.cache_write_tokens = 0)
      or (f.cached_tokens > 0 and f.cache_write_tokens > 0)
    )
  ) as cache_split_rows_known
from filtered f
group by grouping sets ((), (f.tool), (f.model), (f.machine_id));

-- Daily costs use the same materialized candidate set. These year/all plans
-- and the compact response assertion below guard against per-day rescans and
-- accidental unbounded payload growth. Numeric-overflow classification is
-- isolated above without changing the persisted legacy base definition.
explain (analyze, buffers, costs, timing, summary)
with filtered as materialized (
  select t.timestamp, t.input_tokens, t.output_tokens, t.cost_usd
  from public.token_logs t
  where t.user_id = '11111111-1111-1111-1111-111111111111'
    and t.timestamp >= to_char(
      date_trunc('year', now() at time zone 'UTC'),
      'YYYY-MM-DD HH24:MI:SS'
    )
    and t.timestamp <= to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
)
select public.immutable_date_parse(f.timestamp),
  sum(f.input_tokens::numeric + f.output_tokens::numeric),
  bool_or(f.cost_usd is null),
  bool_or(f.cost_usd is not null and (
    f.cost_usd < 0
    or f.cost_usd = '-Infinity'::double precision
    or f.cost_usd = 'Infinity'::double precision
    or f.cost_usd = 'NaN'::double precision
  )),
  bool_or(f.cost_usd = 0),
  sum(case when f.cost_usd > 0 and f.cost_usd < 'Infinity'::double precision
    then f.cost_usd::numeric else 0::numeric end)
from filtered f
group by public.immutable_date_parse(f.timestamp);

explain (analyze, buffers, costs, timing, summary)
with filtered as materialized (
  select t.timestamp, t.input_tokens, t.output_tokens, t.cost_usd
  from public.token_logs t
  where t.user_id = '11111111-1111-1111-1111-111111111111'
    and t.timestamp <= to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
)
select public.immutable_date_parse(f.timestamp),
  sum(f.input_tokens::numeric + f.output_tokens::numeric),
  bool_or(f.cost_usd is null),
  bool_or(f.cost_usd is not null and (
    f.cost_usd < 0
    or f.cost_usd = '-Infinity'::double precision
    or f.cost_usd = 'Infinity'::double precision
    or f.cost_usd = 'NaN'::double precision
  )),
  bool_or(f.cost_usd = 0),
  sum(case when f.cost_usd > 0 and f.cost_usd < 'Infinity'::double precision
    then f.cost_usd::numeric else 0::numeric end)
from filtered f
group by public.immutable_date_parse(f.timestamp);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_result jsonb;
begin
  foreach v_result in array array[
    public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"range":"year","timezone":"UTC","tools":["PerfTool-1"]}'::jsonb
    ),
    public.get_dashboard_stats_v2(
      '11111111-1111-1111-1111-111111111111',
      '{"range":"all","timezone":"UTC","tools":["PerfTool-1"]}'::jsonb
    )
  ] loop
    if pg_catalog.octet_length(v_result::text) > 1048576 then
      raise exception 'dailyCosts dashboard response exceeded 1 MiB budget: % bytes',
        pg_catalog.octet_length(v_result::text);
    end if;
  end loop;
end;
$$;

reset role;

rollback;
