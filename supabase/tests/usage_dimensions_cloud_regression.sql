\set ON_ERROR_STOP on

-- usage-dimensions-cloud-v1: owner-scoped per-day sessions, whitelisted
-- providers and context composition uploaded by desktop, read by Android.
begin;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    'a5d10000-0000-4000-8000-000000000001',
    'usage-dimensions@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  ),
  (
    'a5d10000-0000-4000-8000-000000000002',
    'usage-dimensions-other@example.invalid',
    pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
  );

-- Schema, RLS, grants, search_path and the purge schedule ----------------------
do $schema$
declare
  v_table text;
  v_function text;
begin
  foreach v_table in array array[
    'private.usage_session_days', 'private.usage_provider_days', 'private.usage_context_days'
  ]
  loop
    if pg_catalog.to_regclass(v_table) is null then
      raise exception '% is missing', v_table;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_class c
      where c.oid = pg_catalog.to_regclass(v_table)
        and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception '% must enable and force RLS', v_table;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = pg_catalog.to_regclass(v_table)
        and p.polcmd = 'r'
        and p.polroles = array['authenticated'::pg_catalog.regrole::oid]
    ) then
      raise exception '% lacks the authenticated select-own policy', v_table;
    end if;
    if pg_catalog.has_table_privilege('authenticated', v_table, 'select')
       or pg_catalog.has_table_privilege('authenticated', v_table, 'insert')
       or pg_catalog.has_table_privilege('authenticated', v_table, 'delete')
       or pg_catalog.has_table_privilege('anon', v_table, 'select')
       or pg_catalog.has_table_privilege('service_role', v_table, 'select') then
      raise exception '% must have no client table privileges', v_table;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_constraint k
      where k.conrelid = pg_catalog.to_regclass(v_table)
        and k.contype = 'f'
        and k.confrelid = 'auth.users'::pg_catalog.regclass
        and k.confdeltype = 'c'
    ) then
      raise exception '% must cascade deletes from auth.users', v_table;
    end if;
  end loop;

  foreach v_function in array array[
    'public.sync_usage_dimensions_v1(jsonb)',
    'public.clear_usage_dimension_v1(text)',
    'public.get_usage_dimensions_v1(jsonb)'
  ]
  loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure(v_function)
        and p.prosecdef
        and coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
    ) then
      raise exception '% must be SECURITY DEFINER with empty search_path', v_function;
    end if;
    if not pg_catalog.has_function_privilege('authenticated', v_function, 'execute')
       or pg_catalog.has_function_privilege('anon', v_function, 'execute')
       or pg_catalog.has_function_privilege('public', v_function, 'execute')
       or pg_catalog.has_function_privilege('service_role', v_function, 'execute') then
      raise exception '% must be executable by authenticated only', v_function;
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname like '%usage_dimension%'
      and (
        pg_catalog.has_function_privilege('authenticated', p.oid, 'execute')
        or pg_catalog.has_function_privilege('anon', p.oid, 'execute')
      )
  ) then
    raise exception 'a private usage dimension helper is client-executable';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname like '%usage_dimension%'
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'a usage dimension function lacks an empty fixed search_path';
  end if;
  if not exists (
    select 1 from cron.job
    where jobname = 'tokenledger-usage-dimensions-daily-purge'
      and command like '%purge_expired_usage_dimensions_v1%'
  ) then
    raise exception 'usage dimension purge job is not scheduled';
  end if;
end;
$schema$;

-- Fixture payloads (d0 = server UTC today, d1 = yesterday, d2 = two days ago).
create temporary table usage_fixture (name text primary key, body jsonb not null);
grant select on usage_fixture to authenticated;
do $fixture$
declare
  d0 text := ((pg_catalog.now() at time zone 'UTC')::date)::text;
  d1 text := ((pg_catalog.now() at time zone 'UTC')::date - 1)::text;
  d2 text := ((pg_catalog.now() at time zone 'UTC')::date - 2)::text;
  ka text := pg_catalog.repeat('a', 32);
  kb text := pg_catalog.repeat('b', 32);
  kc text := pg_catalog.repeat('c', 32);
  kd text := pg_catalog.repeat('d', 32);
begin
  insert into usage_fixture values
  ('mac_a', pg_catalog.jsonb_build_object(
    'v', 1,
    'machine', 'mac-a',
    'sessions', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d2, 'truncated', false, 'rows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('key', ka, 'tool', 'codex', 'tokens', 300, 'requests', 2, 'cost', 0.1,
          'firstAt', '22:10', 'lastAt', '23:59', 'topModel', 'gpt-5'),
        pg_catalog.jsonb_build_object('key', kc, 'tool', 'codex', 'tokens', 50, 'requests', 1, 'cost', 0.01,
          'firstAt', '08:00', 'lastAt', '08:30', 'topModel', 'gpt-5')
      )),
      pg_catalog.jsonb_build_object('date', d1, 'rows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('key', ka, 'tool', 'codex', 'tokens', 250, 'requests', 1, 'cost', 0.17,
          'firstAt', '00:00', 'lastAt', '11:15', 'topModel', 'gpt-5-mini'),
        pg_catalog.jsonb_build_object('key', kb, 'tool', 'claude', 'tokens', 400, 'requests', 3, 'cost', null,
          'firstAt', '09:00', 'lastAt', '10:00'),
        pg_catalog.jsonb_build_object('key', kc, 'tool', 'codex', 'tokens', 60, 'requests', 1,
          'firstAt', '09:00', 'lastAt', '09:05', 'topModel', 'gpt-5')
      )),
      pg_catalog.jsonb_build_object('date', d0, 'truncated', false, 'rows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('key', kd, 'tool', 'claude', 'tokens', 400, 'requests', 1, 'cost', 0,
          'firstAt', '07:00', 'lastAt', '07:00', 'topModel', 'claude-opus')
      ))
    )),
    'providers', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d2, 'rows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('provider', 'openai', 'input', 100, 'output', 10, 'cached', 5,
          'cacheWrite', 1, 'requests', 2, 'cost', 0.05),
        pg_catalog.jsonb_build_object('provider', 'other', 'input', 5000, 'output', 0, 'cached', 0,
          'cacheWrite', 0, 'requests', 1, 'cost', 1)
      )),
      pg_catalog.jsonb_build_object('date', d1, 'rows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('provider', 'openai', 'input', 300, 'output', 40, 'cached', 495,
          'cacheWrite', 0, 'requests', 4, 'cost', 0.07),
        pg_catalog.jsonb_build_object('provider', 'anthropic', 'input', 200, 'output', 20, 'cached', 0,
          'cacheWrite', 0, 'requests', 1, 'cost', null),
        pg_catalog.jsonb_build_object('provider', 'other', 'input', 1, 'output', 1, 'cached', 0,
          'cacheWrite', 0, 'requests', 1, 'cost', 0.5)
      ))
    )),
    'context', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d2, 'row', pg_catalog.jsonb_build_object(
        'requests', 2, 'promptTokens', 300, 'systemBytes', 10, 'toolsBytes', 20, 'historyBytes', 30,
        'toolResultsBytes', 40, 'attachmentsBytes', 50, 'messages', 4, 'toolResults', 1, 'attachments', 1)),
      pg_catalog.jsonb_build_object('date', d1, 'row', pg_catalog.jsonb_build_object(
        'requests', 4, 'promptTokens', 600, 'systemBytes', 1, 'toolsBytes', 1, 'historyBytes', 1,
        'toolResultsBytes', 1, 'attachmentsBytes', 1, 'messages', 2, 'toolResults', 1, 'attachments', 1)),
      pg_catalog.jsonb_build_object('date', d0, 'row', null)
    ))
  )),
  -- A second device with a truncated day of 120 sessions (tokens 1000..120000).
  ('mac_b', pg_catalog.jsonb_build_object(
    'v', 1,
    'machine', 'mac-b',
    'sessions', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d0, 'truncated', true, 'rows', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'key', pg_catalog.md5('mac-b:' || i), 'tool', 'codex', 'tokens', i * 1000, 'requests', 1,
          'cost', 0.001, 'firstAt', '12:00', 'lastAt', '12:30', 'topModel', 'gpt-5'))
        from pg_catalog.generate_series(1, 120) as g(i)
      ))
    )),
    'context', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d0, 'row', pg_catalog.jsonb_build_object(
        'requests', 1, 'promptTokens', 100, 'systemBytes', 0, 'toolsBytes', 0, 'historyBytes', 0,
        'toolResultsBytes', 0, 'attachmentsBytes', 0, 'messages', 0, 'toolResults', 0, 'attachments', 0))
    ))
  ));
end;
$fixture$;

-- Anonymous callers are refused at the grant boundary ------------------------
set local role anon;
do $anon$
begin
  begin
    perform public.sync_usage_dimensions_v1('{"v":1,"machine":"m"}'::jsonb);
    raise exception 'anonymous sync unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_usage_dimensions_v1('{"range":"today","timezone":"UTC"}'::jsonb);
    raise exception 'anonymous read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.clear_usage_dimension_v1('sessions');
    raise exception 'anonymous clear unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$anon$;
reset role;

-- Authenticated role without a subject is refused by the identity check.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '', true);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
do $nosub$
declare
  v_reason text;
begin
  begin
    perform public.sync_usage_dimensions_v1('{"v":1,"machine":"m"}'::jsonb);
    raise exception 'sync without subject unexpectedly succeeded';
  exception when sqlstate '42501' then
    get stacked diagnostics v_reason = message_text;
    if v_reason <> 'usage_dimensions_identity_required' then
      raise exception 'sync without subject reported %', v_reason;
    end if;
  end;
  begin
    perform public.get_usage_dimensions_v1('{"range":"today","timezone":"UTC"}'::jsonb);
    raise exception 'read without subject unexpectedly succeeded';
  exception when sqlstate '42501' then null;
  end;
end;
$nosub$;

select pg_catalog.set_config('request.jwt.claim.sub', 'a5d10000-0000-4000-8000-000000000001', true);

-- Owner: store, idempotency, replace-per-day ----------------------------------
do $store$
declare
  v_a jsonb := (select body from usage_fixture where name = 'mac_a');
  v_b jsonb := (select body from usage_fixture where name = 'mac_b');
  d0 text := ((pg_catalog.now() at time zone 'UTC')::date)::text;
  d2 text := ((pg_catalog.now() at time zone 'UTC')::date - 2)::text;
  q jsonb := pg_catalog.jsonb_build_object(
    'range', 'custom', 'start', d2, 'end', d0, 'timezone', 'UTC', 'machines', '["mac-a"]'::jsonb
  );
  v_result jsonb;
  v_first jsonb;
  v_read jsonb;
begin
  begin
    perform 1 from private.usage_session_days;
    raise exception 'direct table read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  v_result := public.sync_usage_dimensions_v1(v_a);
  if v_result <> '{"stored":{"sessions":6,"providers":5,"context":2},"purged":0,"retentionDays":90}'::jsonb then
    raise exception 'first sync returned %', v_result;
  end if;
  v_first := public.get_usage_dimensions_v1(q);

  -- Re-uploading the same batch yields the same rows and the same read.
  v_result := public.sync_usage_dimensions_v1(v_a);
  if v_result <> '{"stored":{"sessions":6,"providers":5,"context":2},"purged":0,"retentionDays":90}'::jsonb then
    raise exception 'repeat sync returned %', v_result;
  end if;
  if public.get_usage_dimensions_v1(q) <> v_first then
    raise exception 'repeat sync changed the read: %', public.get_usage_dimensions_v1(q);
  end if;

  -- Replace per day: only the listed dates of the listed dimensions change.
  v_result := public.sync_usage_dimensions_v1(pg_catalog.jsonb_build_object(
    'v', 1, 'machine', 'mac-a',
    'sessions', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d0, 'rows', '[]'::jsonb),
      (v_a #> '{sessions,days,1}') || pg_catalog.jsonb_build_object('rows', (v_a #> '{sessions,days,1,rows}') - 0 - 1)
    )),
    'context', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d2, 'row', null)
    ))
  ));
  if v_result #> '{stored}' <> '{"sessions":1,"providers":0,"context":0}'::jsonb then
    raise exception 'partial replace returned %', v_result;
  end if;
  v_read := public.get_usage_dimensions_v1(q);
  -- d0 emptied, d1 keeps only B, d2 untouched (A 300, C 50).
  if v_read #>> '{sessions,sessionCount}' <> '3'
     or v_read #>> '{sessions,rows,0,id}' <> pg_catalog.repeat('b', 32)
     or v_read #>> '{sessions,rows,1,id}' <> pg_catalog.repeat('a', 32)
     or v_read #>> '{sessions,rows,1,tokens}' <> '300'
     or v_read #>> '{sessions,rows,1,days}' <> '1'
     or v_read #>> '{sessions,rows,2,id}' <> pg_catalog.repeat('c', 32)
     or v_read #>> '{sessions,rows,2,tokens}' <> '50' then
    raise exception 'replace-per-day sessions wrong: %', v_read -> 'sessions';
  end if;
  if v_read -> 'providers' <> v_first -> 'providers' then
    raise exception 'an omitted dimension changed: %', v_read -> 'providers';
  end if;
  if v_read #>> '{contextComposition,requests}' <> '4' then
    raise exception 'context row null did not clear its day: %', v_read -> 'contextComposition';
  end if;

  -- Restore and add the second device.
  perform public.sync_usage_dimensions_v1(v_a);
  if public.get_usage_dimensions_v1(q) <> v_first then
    raise exception 'restoring the batch did not restore the read';
  end if;
  v_result := public.sync_usage_dimensions_v1(v_b);
  if v_result #> '{stored}' <> '{"sessions":120,"providers":0,"context":1}'::jsonb then
    raise exception 'second device sync returned %', v_result;
  end if;
end;
$store$;

-- Rejections: one per contract reason, nothing written ------------------------
do $reject$
declare
  v_a jsonb := (select body from usage_fixture where name = 'mac_a');
  d0 date := (pg_catalog.now() at time zone 'UTC')::date;
  v_session jsonb := v_a #> '{sessions,days,0,rows,0}';
  v_provider jsonb := v_a #> '{providers,days,0,rows,0}';
  v_context jsonb := v_a #> '{context,days,0,row}';
  v_case text;
  v_expected text;
  v_bad jsonb;
  v_reason text;
  v_before bigint;
  v_after bigint;
begin
  reset role;
  select (select pg_catalog.count(*) from private.usage_session_days)
    + (select pg_catalog.count(*) from private.usage_provider_days)
    + (select pg_catalog.count(*) from private.usage_context_days)
    into v_before;
  set local role authenticated;

  foreach v_case in array array[
    'not_object', 'missing_v', 'version', 'unknown_key', 'machine_empty', 'machine_long',
    'machine_number', 'dimension_null', 'days_object', 'dimension_key', 'day_key', 'date_format',
    'date_calendar', 'date_dup', 'key_upper', 'key_dup', 'key_missing', 'tool_empty',
    'tool_long', 'tokens_negative', 'tokens_fraction', 'tokens_string', 'tokens_overflow',
    'requests_zero', 'cost_negative', 'cost_string', 'clock_24', 'clock_seconds', 'clock_order',
    'row_key', 'truncated_string', 'truncated_empty', 'top_model_number', 'provider_number',
    'provider_dup', 'provider_missing_field', 'context_missing', 'context_requests_zero',
    'context_extra', 'context_rows', 'atomic',
    'too_large_text', 'too_many_days', 'too_many_session_rows', 'too_many_total_rows',
    'date_too_old', 'date_too_new',
    'provider_case', 'provider_custom', 'provider_space'
  ]
  loop
    v_expected := case
      when v_case like 'too\_%' then 'usage_dimensions_payload_too_large'
      when v_case in ('date_too_old', 'date_too_new') then 'usage_dimensions_date_out_of_range'
      when v_case like 'provider\_%' and v_case not in ('provider_number', 'provider_dup', 'provider_missing_field')
        then 'usage_dimensions_provider_not_allowed'
      else 'usage_dimensions_invalid_payload'
    end;
    v_bad := case v_case
      when 'not_object' then '[]'::jsonb
      when 'missing_v' then v_a - 'v'
      when 'version' then pg_catalog.jsonb_set(v_a, '{v}', '2'::jsonb)
      when 'unknown_key' then v_a || '{"prompt":"hello"}'::jsonb
      when 'machine_empty' then pg_catalog.jsonb_set(v_a, '{machine}', '""'::jsonb)
      when 'machine_long' then pg_catalog.jsonb_set(v_a, '{machine}', pg_catalog.to_jsonb(pg_catalog.repeat('m', 129)))
      when 'machine_number' then pg_catalog.jsonb_set(v_a, '{machine}', '7'::jsonb)
      when 'dimension_null' then pg_catalog.jsonb_set(v_a, '{sessions}', 'null'::jsonb)
      when 'days_object' then pg_catalog.jsonb_set(v_a, '{providers,days}', '{}'::jsonb)
      when 'dimension_key' then pg_catalog.jsonb_set(v_a, '{context,truncated}', 'true'::jsonb)
      when 'day_key' then pg_catalog.jsonb_set(v_a, '{providers,days,0,truncated}', 'false'::jsonb)
      when 'date_format' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,date}', pg_catalog.to_jsonb(pg_catalog.to_char(d0, 'YYYY/MM/DD')))
      when 'date_calendar' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,date}', '"2026-02-30"'::jsonb)
      when 'date_dup' then pg_catalog.jsonb_set(v_a, '{context,days,1,date}', v_a #> '{context,days,0,date}')
      when 'key_upper' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,key}', pg_catalog.to_jsonb(pg_catalog.repeat('A', 32)))
      when 'key_dup' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,1,key}', v_session -> 'key')
      when 'key_missing' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0}', v_session - 'key')
      when 'tool_empty' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,tool}', '""'::jsonb)
      when 'tool_long' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,tool}', pg_catalog.to_jsonb(pg_catalog.repeat('t', 129)))
      when 'tokens_negative' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,tokens}', '-1'::jsonb)
      when 'tokens_fraction' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,tokens}', '1.5'::jsonb)
      when 'tokens_string' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,tokens}', '"300"'::jsonb)
      when 'tokens_overflow' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0,input}', '9223372036854775808'::jsonb)
      when 'requests_zero' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0,requests}', '0'::jsonb)
      when 'cost_negative' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,cost}', '-0.01'::jsonb)
      when 'cost_string' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0,cost}', '"0.05"'::jsonb)
      when 'clock_24' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,lastAt}', '"24:00"'::jsonb)
      when 'clock_seconds' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,firstAt}', '"22:10:05"'::jsonb)
      when 'clock_order' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,1,firstAt}', '"09:00"'::jsonb)
      when 'row_key' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,cwd}', '"/work/project"'::jsonb)
      when 'truncated_string' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,truncated}', '"no"'::jsonb)
      when 'truncated_empty' then pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows}', '[]'::jsonb), '{sessions,days,0,truncated}', 'true'::jsonb)
      when 'top_model_number' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows,0,topModel}', '5'::jsonb)
      when 'provider_number' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0,provider}', '1'::jsonb)
      when 'provider_dup' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,1,provider}', '"openai"'::jsonb)
      when 'provider_missing_field' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0}', v_provider - 'cacheWrite')
      when 'context_missing' then pg_catalog.jsonb_set(v_a, '{context,days,0,row}', v_context - 'attachments')
      when 'context_requests_zero' then pg_catalog.jsonb_set(v_a, '{context,days,0,row,requests}', '0'::jsonb)
      when 'context_extra' then pg_catalog.jsonb_set(v_a, '{context,days,0,row,promptText}', '"secret"'::jsonb)
      when 'context_rows' then pg_catalog.jsonb_set(v_a, '{context,days,0}',
        (v_a #> '{context,days,0}') - 'row' || '{"rows":[]}'::jsonb)
      -- A valid providers batch must not be written when sessions are invalid.
      when 'atomic' then pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(v_a, '{providers,days,0,rows}', '[]'::jsonb),
        '{sessions,days,2,rows,0,requests}', '0'::jsonb)
      when 'too_large_text' then pg_catalog.jsonb_set(v_a, '{machine}', pg_catalog.to_jsonb(pg_catalog.repeat('m', 2097152)))
      when 'too_many_days' then pg_catalog.jsonb_set(v_a, '{providers,days}', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('date', (d0 - g.i)::text, 'rows', '[]'::jsonb))
        from pg_catalog.generate_series(0, 92) as g(i)
      ))
      when 'too_many_session_rows' then pg_catalog.jsonb_set(v_a, '{sessions,days,0,rows}', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_set(v_session, '{key}', pg_catalog.to_jsonb(pg_catalog.md5('r' || g.i))))
        from pg_catalog.generate_series(1, 501) as g(i)
      ))
      -- 20 days x 500 sessions = 10000 rows, plus one provider row = 10001.
      when 'too_many_total_rows' then pg_catalog.jsonb_build_object(
        'v', 1, 'machine', 'mac-big',
        'sessions', pg_catalog.jsonb_build_object('days', (
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('date', (d0 - g.i)::text, 'rows', (
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'key', pg_catalog.md5(g.i || ':' || h.j), 'tool', 'codex', 'tokens', 1, 'requests', 1,
              'firstAt', '00:00', 'lastAt', '00:00'))
            from pg_catalog.generate_series(1, 500) as h(j)
          )))
          from pg_catalog.generate_series(0, 19) as g(i)
        )),
        'providers', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('date', d0::text, 'rows', pg_catalog.jsonb_build_array(v_provider))
        ))
      )
      when 'date_too_old' then pg_catalog.jsonb_set(v_a, '{providers,days,0,date}', pg_catalog.to_jsonb((d0 - 91)::text))
      when 'date_too_new' then pg_catalog.jsonb_set(v_a, '{context,days,0,date}', pg_catalog.to_jsonb((d0 + 2)::text))
      when 'provider_case' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0,provider}', '"OpenAI"'::jsonb)
      when 'provider_custom' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0,provider}', '"acme-proxy"'::jsonb)
      when 'provider_space' then pg_catalog.jsonb_set(v_a, '{providers,days,0,rows,0,provider}', '" openai"'::jsonb)
      else v_a
    end;
    begin
      perform public.sync_usage_dimensions_v1(v_bad);
      raise exception 'case % was accepted', v_case;
    exception when invalid_parameter_value then
      get stacked diagnostics v_reason = message_text;
      if v_reason <> v_expected then
        raise exception 'case % reported % (expected %)', v_case, v_reason, v_expected;
      end if;
    end;
  end loop;

  -- The window edges themselves are accepted.
  perform public.sync_usage_dimensions_v1(pg_catalog.jsonb_build_object(
    'v', 1, 'machine', 'mac-edge',
    'context', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', (d0 - 90)::text, 'row', null),
      pg_catalog.jsonb_build_object('date', (d0 + 1)::text, 'row', null)
    ))
  ));

  reset role;
  select (select pg_catalog.count(*) from private.usage_session_days)
    + (select pg_catalog.count(*) from private.usage_provider_days)
    + (select pg_catalog.count(*) from private.usage_context_days)
    into v_after;
  if v_after <> v_before then
    raise exception 'rejected batches changed stored rows: % -> %', v_before, v_after;
  end if;
  set local role authenticated;
end;
$reject$;

-- Provider whitelist: every canonical name is accepted -------------------------
do $whitelist$
declare
  d0 text := ((pg_catalog.now() at time zone 'UTC')::date)::text;
  v_result jsonb;
begin
  v_result := public.sync_usage_dimensions_v1(pg_catalog.jsonb_build_object(
    'v', 1, 'machine', 'mac-whitelist',
    'providers', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d0, 'rows', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'provider', n.name, 'input', 1, 'output', 1, 'cached', 0, 'cacheWrite', 0, 'requests', 1, 'cost', 0))
        from pg_catalog.unnest(array[
          'anthropic', 'ark', 'deepseek', 'gemini', 'glm', 'groq', 'kimi', 'lmstudio',
          'mistral', 'ollama', 'openai', 'openrouter', 'qwen', 'siliconflow', 'xai', 'other'
        ]) as n(name)
      ))
    ))
  ));
  if v_result #>> '{stored,providers}' <> '16' then
    raise exception 'whitelist batch stored %', v_result;
  end if;
  v_result := public.get_usage_dimensions_v1(pg_catalog.jsonb_build_object(
    'range', 'today', 'timezone', 'UTC', 'machines', '["mac-whitelist"]'::jsonb
  ));
  if pg_catalog.jsonb_array_length(v_result #> '{providers,rows}') <> 16
     or v_result #>> '{providers,rows,15,provider}' <> 'other' then
    raise exception 'whitelist read wrong: %', v_result -> 'providers';
  end if;
  -- Remove the whitelist device again so later provider totals stay small.
  perform public.sync_usage_dimensions_v1(pg_catalog.jsonb_build_object(
    'v', 1, 'machine', 'mac-whitelist',
    'providers', pg_catalog.jsonb_build_object('days', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('date', d0, 'rows', '[]'::jsonb)
    ))
  ));
end;
$whitelist$;

-- Reads: merge, top 100, cost nulls, ordering, filters -------------------------
do $read$
declare
  d0 text := ((pg_catalog.now() at time zone 'UTC')::date)::text;
  d1 text := ((pg_catalog.now() at time zone 'UTC')::date - 1)::text;
  d2 text := ((pg_catalog.now() at time zone 'UTC')::date - 2)::text;
  q jsonb := pg_catalog.jsonb_build_object('range', 'custom', 'start', d2, 'end', d0, 'timezone', 'UTC');
  r jsonb;
  v_row jsonb;
begin
  -- One device: cross-day merge and cost null propagation.
  r := public.get_usage_dimensions_v1(q || '{"machines":["mac-a"]}'::jsonb);
  if r -> 'meta' <> pg_catalog.jsonb_build_object(
       'source', 'cloud', 'start', d2, 'end', d0, 'timezone', 'UTC', 'retentionDays', 90,
       'coverageStart', ((pg_catalog.now() at time zone 'UTC')::date - 90)::text
     ) then
    raise exception 'meta wrong: %', r -> 'meta';
  end if;
  if r #>> '{sessions,state}' <> 'ok'
     or r #>> '{sessions,sessionCount}' <> '4'
     or r #>> '{sessions,truncatedDays}' <> '0'
     or r #>> '{sessions,sessionLimit}' <> '100'
     or pg_catalog.jsonb_array_length(r #> '{sessions,rows}') <> 4 then
    raise exception 'single-device session summary wrong: %', r -> 'sessions';
  end if;
  v_row := r #> '{sessions,rows,0}';
  if v_row <> pg_catalog.jsonb_build_object(
       'id', pg_catalog.repeat('a', 32), 'machine', 'mac-a', 'tool', 'codex', 'tokens', 550,
       'requests', 3, 'cost', 0.27, 'days', 2, 'firstDate', d2, 'lastDate', d1,
       'firstAt', '22:10', 'lastAt', '11:15', 'topModel', 'gpt-5'
     ) then
    raise exception 'cross-day merge wrong: %', v_row;
  end if;
  -- Equal tokens order by id ascending; a null cost on any day nulls the merge.
  if r #>> '{sessions,rows,1,id}' <> pg_catalog.repeat('b', 32)
     or r #> '{sessions,rows,1,cost}' <> 'null'::jsonb
     or r #> '{sessions,rows,1,topModel}' <> 'null'::jsonb
     or r #>> '{sessions,rows,2,id}' <> pg_catalog.repeat('d', 32)
     or (r #>> '{sessions,rows,2,cost}')::numeric <> 0
     or r #>> '{sessions,rows,3,id}' <> pg_catalog.repeat('c', 32)
     or r #>> '{sessions,rows,3,tokens}' <> '110'
     or r #> '{sessions,rows,3,cost}' <> 'null'::jsonb
     or r #>> '{sessions,rows,3,days}' <> '2' then
    raise exception 'session ordering or cost nulls wrong: %', r #> '{sessions,rows}';
  end if;

  if r -> 'providers' <> '{"state":"ok","rows":[
       {"provider":"openai","input":400,"output":50,"cached":500,"cacheWrite":1,"total":450,"requests":6,"cost":0.12},
       {"provider":"anthropic","input":200,"output":20,"cached":0,"cacheWrite":0,"total":220,"requests":1,"cost":null},
       {"provider":"other","input":5001,"output":1,"cached":0,"cacheWrite":0,"total":5002,"requests":2,"cost":1.5}
     ]}'::jsonb then
    raise exception 'provider split wrong: %', r -> 'providers';
  end if;
  if r -> 'contextComposition' <> '{"state":"ok","requests":6,"promptTokens":900,"systemBytes":11,
       "toolsBytes":21,"historyBytes":31,"toolResultsBytes":41,"attachmentsBytes":51,
       "messages":6,"toolResults":2,"attachments":2}'::jsonb then
    raise exception 'context composition wrong: %', r -> 'contextComposition';
  end if;

  -- All devices: top-100 limit, full count and truncated device-days.
  r := public.get_usage_dimensions_v1(q);
  if r #>> '{sessions,sessionCount}' <> '124'
     or r #>> '{sessions,truncatedDays}' <> '1'
     or pg_catalog.jsonb_array_length(r #> '{sessions,rows}') <> 100
     or r #>> '{sessions,rows,0,tokens}' <> '120000'
     or r #>> '{sessions,rows,0,machine}' <> 'mac-b'
     or r #>> '{sessions,rows,99,tokens}' <> '21000'
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(r #> '{sessions,rows}') as e(value)
       where e.value ->> 'machine' <> 'mac-b'
     ) then
    raise exception 'top-100 sessions wrong: count % truncated % first % last %',
      r #>> '{sessions,sessionCount}', r #>> '{sessions,truncatedDays}',
      r #> '{sessions,rows,0}', r #> '{sessions,rows,99}';
  end if;
  if r #>> '{contextComposition,requests}' <> '7' or r #>> '{contextComposition,promptTokens}' <> '1000' then
    raise exception 'context across devices wrong: %', r -> 'contextComposition';
  end if;

  -- Today only.
  r := public.get_usage_dimensions_v1('{"range":"today","timezone":"UTC","machines":["mac-a"]}'::jsonb);
  if r #>> '{sessions,sessionCount}' <> '1' or r #>> '{sessions,rows,0,id}' <> pg_catalog.repeat('d', 32)
     or r #>> '{providers,state}' <> 'empty' or r #> '{providers,rows}' <> '[]'::jsonb
     or r #>> '{contextComposition,state}' <> 'empty' or r #>> '{contextComposition,requests}' <> '0' then
    raise exception 'today read wrong: %', r;
  end if;

  -- Tool filter: sessions honour it, providers and context are filtered.
  r := public.get_usage_dimensions_v1(q || '{"machines":["mac-a"],"tools":["claude"]}'::jsonb);
  if r #>> '{sessions,state}' <> 'ok'
     or r #>> '{sessions,sessionCount}' <> '2'
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(r #> '{sessions,rows}') as e(value)
       where e.value ->> 'tool' <> 'claude'
     )
     or r -> 'providers' <> '{"state":"filtered"}'::jsonb
     or r -> 'contextComposition' <> '{"state":"filtered"}'::jsonb then
    raise exception 'tool filter wrong: %', r;
  end if;
  r := public.get_usage_dimensions_v1(q || '{"tools":["no-such-tool"]}'::jsonb);
  if r #>> '{sessions,state}' <> 'empty' or r #>> '{sessions,sessionCount}' <> '0'
     or r #> '{sessions,rows}' <> '[]'::jsonb then
    raise exception 'tool filter with no match must be empty: %', r -> 'sessions';
  end if;

  -- Model filter or search: every dimension is filtered with no other fields.
  foreach v_row in array array['{"models":["gpt-5"]}'::jsonb, '{"search":"codex"}'::jsonb] loop
    r := public.get_usage_dimensions_v1(q || v_row);
    if r -> 'sessions' <> '{"state":"filtered"}'::jsonb
       or r -> 'providers' <> '{"state":"filtered"}'::jsonb
       or r -> 'contextComposition' <> '{"state":"filtered"}'::jsonb
       or r -> 'meta' is null then
      raise exception 'filter % must mark all dimensions filtered: %', v_row, r;
    end if;
  end loop;

  -- Invalid queries use the Stats v2 validation.
  begin
    perform public.get_usage_dimensions_v1('{"range":"decade"}'::jsonb);
    raise exception 'invalid range was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$read$;

-- Another owner sees nothing and cannot clear the first owner's rows ----------
select pg_catalog.set_config('request.jwt.claim.sub', 'a5d10000-0000-4000-8000-000000000002', true);
do $other$
declare
  r jsonb := public.get_usage_dimensions_v1('{"range":"all","timezone":"UTC"}'::jsonb);
begin
  if r -> 'sessions' <> '{"state":"empty","sessionCount":0,"truncatedDays":0,"sessionLimit":100,"rows":[]}'::jsonb
     or r -> 'providers' <> '{"state":"empty","rows":[]}'::jsonb
     or r -> 'contextComposition' <> '{"state":"empty","requests":0,"promptTokens":0,"systemBytes":0,
          "toolsBytes":0,"historyBytes":0,"toolResultsBytes":0,"attachmentsBytes":0,
          "messages":0,"toolResults":0,"attachments":0}'::jsonb
     or r #>> '{meta,start}' <> r #>> '{meta,coverageStart}' then
    raise exception 'another owner can see rows or empty shape is wrong: %', r;
  end if;
  if public.clear_usage_dimension_v1('sessions') <> '{"deleted":0}'::jsonb then
    raise exception 'another owner deleted session rows';
  end if;
end;
$other$;
reset role;

-- Retention: expired rows are hidden, purged on the owner's next upload, and
-- the daily job purges abandoned owners ---------------------------------------
do $expire$
declare
  v_old date := (pg_catalog.now() at time zone 'UTC')::date - 91;
  u1 uuid := 'a5d10000-0000-4000-8000-000000000001';
  u2 uuid := 'a5d10000-0000-4000-8000-000000000002';
  v_user uuid;
begin
  foreach v_user in array array[u1, u2] loop
    insert into private.usage_session_days (
      user_id, machine_id, local_date, session_key, tool, tokens, requests, first_at, last_at
    ) values (v_user, 'mac-a', v_old, pg_catalog.repeat('f', 32), 'codex', 999999, 1, '01:00', '02:00');
    insert into private.usage_provider_days (
      user_id, machine_id, local_date, provider, input_tokens, output_tokens, cached_tokens,
      cache_write_tokens, requests
    ) values (v_user, 'mac-a', v_old, 'openai', 999999, 0, 0, 0, 1);
    insert into private.usage_context_days (
      user_id, machine_id, local_date, requests, prompt_tokens, system_bytes, tools_bytes,
      history_bytes, tool_results_bytes, attachments_bytes, messages, tool_results, attachments
    ) values (v_user, 'mac-a', v_old, 1, 999999, 0, 0, 0, 0, 0, 0, 0, 0);
  end loop;
end;
$expire$;

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', 'a5d10000-0000-4000-8000-000000000001', true);
do $retention$
declare
  v_old text := ((pg_catalog.now() at time zone 'UTC')::date - 91)::text;
  q jsonb := pg_catalog.jsonb_build_object(
    'range', 'custom', 'start', v_old, 'end', v_old, 'timezone', 'UTC'
  );
  r jsonb;
begin
  r := public.get_usage_dimensions_v1(q);
  if r #>> '{sessions,state}' <> 'empty' or r #>> '{providers,state}' <> 'empty'
     or r #>> '{contextComposition,state}' <> 'empty' or r #>> '{meta,start}' <> v_old then
    raise exception 'expired rows are visible before purge: %', r;
  end if;
  r := public.get_usage_dimensions_v1('{"range":"all","timezone":"UTC","machines":["mac-a"]}'::jsonb);
  if r #>> '{contextComposition,promptTokens}' <> '900' then
    raise exception 'range all included expired rows: %', r -> 'contextComposition';
  end if;
  r := public.sync_usage_dimensions_v1((select body from usage_fixture where name = 'mac_b'));
  if r ->> 'purged' <> '3' then
    raise exception 'upload did not purge exactly the owner''s 3 expired rows: %', r;
  end if;
end;
$retention$;
reset role;

do $purge$
declare
  u2 uuid := 'a5d10000-0000-4000-8000-000000000002';
begin
  if (select pg_catalog.count(*) from private.usage_context_days where user_id = u2) <> 1 then
    raise exception 'an owner upload purged another owner''s rows';
  end if;
  if private.purge_expired_usage_dimensions_v1() <> 3 then
    raise exception 'daily purge did not remove exactly the abandoned owner''s 3 rows';
  end if;
  if exists (select 1 from private.usage_session_days where user_id = u2)
     or exists (select 1 from private.usage_provider_days where user_id = u2)
     or exists (select 1 from private.usage_context_days where user_id = u2) then
    raise exception 'expired rows survived the daily purge';
  end if;
  if private.purge_expired_usage_dimensions_v1() <> 0 then
    raise exception 'daily purge removed rows inside the retention window';
  end if;
end;
$purge$;

-- Clear: one dimension, every device, owner only -------------------------------
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', 'a5d10000-0000-4000-8000-000000000001', true);
do $clear$
declare
  r jsonb;
  v_reason text;
begin
  foreach v_reason in array array['tokens', 'Sessions', ''] loop
    begin
      perform public.clear_usage_dimension_v1(v_reason);
      raise exception 'clear % was accepted', v_reason;
    exception when invalid_parameter_value then
      get stacked diagnostics v_reason = message_text;
      if v_reason <> 'usage_dimensions_invalid_payload' then
        raise exception 'invalid clear reported %', v_reason;
      end if;
    end;
  end loop;
  begin
    perform public.clear_usage_dimension_v1(null);
    raise exception 'clear null was accepted';
  exception when invalid_parameter_value then null;
  end;

  -- mac-a: 6 session rows, mac-b: 120.
  if public.clear_usage_dimension_v1('sessions') <> '{"deleted":126}'::jsonb
     or public.clear_usage_dimension_v1('sessions') <> '{"deleted":0}'::jsonb then
    raise exception 'session clear did not delete every device''s rows exactly once';
  end if;
  r := public.get_usage_dimensions_v1('{"range":"all","timezone":"UTC"}'::jsonb);
  if r #>> '{sessions,state}' <> 'empty' or r #>> '{providers,state}' <> 'ok'
     or r #>> '{contextComposition,state}' <> 'ok' then
    raise exception 'clearing sessions touched another dimension: %', r;
  end if;
  if public.clear_usage_dimension_v1('providers') <> '{"deleted":5}'::jsonb
     or public.clear_usage_dimension_v1('context') <> '{"deleted":3}'::jsonb then
    raise exception 'provider/context clear counts wrong';
  end if;
end;
$clear$;
reset role;

-- Deleting the auth user cascades to every dimension.
do $cascade$
declare
  u1 uuid := 'a5d10000-0000-4000-8000-000000000001';
  d0 date := (pg_catalog.now() at time zone 'UTC')::date;
begin
  insert into private.usage_session_days (
    user_id, machine_id, local_date, session_key, tool, tokens, requests, first_at, last_at
  ) values (u1, 'mac-a', d0, pg_catalog.repeat('e', 32), 'codex', 1, 1, '01:00', '01:00');
  delete from auth.users where id = u1;
  if exists (select 1 from private.usage_session_days where user_id = u1) then
    raise exception 'deleting the auth user did not cascade';
  end if;
end;
$cascade$;

rollback;
