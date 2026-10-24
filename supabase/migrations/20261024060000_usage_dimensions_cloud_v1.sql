-- 云端用量维度 v1：会话、账号（网关供应商白名单）、平均 Context 构成。
-- 契约见 docs/contracts/usage-dimensions-cloud-v1.md §2–§4，方案见
-- docs/design/cloud-usage-dimensions-v1.md。
--
-- 桌面把本机已算好的三个维度按本地日聚合后上传（默认关闭，用户逐项开启），
-- Android 只读。云端不重新去重、不重新估价；只保留最近 90 天
-- （local_date >= 服务器 UTC 日期 - 90）。三张私有表互相独立，可单独清空、
-- 单独回滚；不改 token_logs 与已有 RPC。

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage (contract §2).
-- ---------------------------------------------------------------------------

create table private.usage_session_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  machine_id text not null,
  local_date date not null,
  session_key text not null,
  tool text not null,
  tokens bigint not null,
  requests bigint not null,
  cost_usd numeric,
  first_at text not null,
  last_at text not null,
  top_model text,
  -- 该设备日是否超过每日 500 个会话被截断；同一设备日的所有行取值相同。
  truncated boolean not null default false,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, machine_id, local_date, session_key),
  constraint usage_session_days_machine_check
    check (pg_catalog.char_length(machine_id) between 1 and 128),
  constraint usage_session_days_key_check
    check (session_key ~ '^[0-9a-f]{32}$'),
  constraint usage_session_days_tool_check
    check (pg_catalog.char_length(tool) between 1 and 128),
  constraint usage_session_days_top_model_check
    check (top_model is null or pg_catalog.char_length(top_model) between 1 and 128),
  constraint usage_session_days_counts_check
    check (tokens >= 0 and requests >= 1),
  constraint usage_session_days_cost_check
    check (cost_usd is null or (cost_usd >= 0 and cost_usd < 'Infinity'::numeric)),
  constraint usage_session_days_times_check
    check (
      first_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and last_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and first_at <= last_at
    )
);

create table private.usage_provider_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  machine_id text not null,
  local_date date not null,
  provider text not null,
  input_tokens bigint not null,
  output_tokens bigint not null,
  cached_tokens bigint not null,
  cache_write_tokens bigint not null,
  requests bigint not null,
  cost_usd numeric,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, machine_id, local_date, provider),
  constraint usage_provider_days_machine_check
    check (pg_catalog.char_length(machine_id) between 1 and 128),
  -- 账号名白名单（契约 §2.1）；名单外由桌面归为 other。
  constraint usage_provider_days_provider_check
    check (provider in (
      'anthropic', 'ark', 'deepseek', 'gemini', 'glm', 'groq', 'kimi', 'lmstudio',
      'mistral', 'ollama', 'openai', 'openrouter', 'qwen', 'siliconflow', 'xai', 'other'
    )),
  constraint usage_provider_days_counts_check
    check (
      input_tokens >= 0 and output_tokens >= 0 and cached_tokens >= 0
      and cache_write_tokens >= 0 and requests >= 1
    ),
  constraint usage_provider_days_cost_check
    check (cost_usd is null or (cost_usd >= 0 and cost_usd < 'Infinity'::numeric))
);

create table private.usage_context_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  machine_id text not null,
  local_date date not null,
  requests bigint not null,
  prompt_tokens bigint not null,
  system_bytes bigint not null,
  tools_bytes bigint not null,
  history_bytes bigint not null,
  tool_results_bytes bigint not null,
  attachments_bytes bigint not null,
  messages bigint not null,
  tool_results bigint not null,
  attachments bigint not null,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (user_id, machine_id, local_date),
  constraint usage_context_days_machine_check
    check (pg_catalog.char_length(machine_id) between 1 and 128),
  constraint usage_context_days_counts_check
    check (
      requests >= 1 and prompt_tokens >= 0 and system_bytes >= 0 and tools_bytes >= 0
      and history_bytes >= 0 and tool_results_bytes >= 0 and attachments_bytes >= 0
      and messages >= 0 and tool_results >= 0 and attachments >= 0
    )
);

-- Owner reads filter by local_date without a machine; the daily purge scans by date.
create index usage_session_days_user_date_idx
  on private.usage_session_days (user_id, local_date);
create index usage_session_days_date_idx
  on private.usage_session_days (local_date);
create index usage_provider_days_user_date_idx
  on private.usage_provider_days (user_id, local_date);
create index usage_provider_days_date_idx
  on private.usage_provider_days (local_date);
create index usage_context_days_user_date_idx
  on private.usage_context_days (user_id, local_date);
create index usage_context_days_date_idx
  on private.usage_context_days (local_date);

alter table private.usage_session_days enable row level security;
alter table private.usage_session_days force row level security;
alter table private.usage_provider_days enable row level security;
alter table private.usage_provider_days force row level security;
alter table private.usage_context_days enable row level security;
alter table private.usage_context_days force row level security;

drop policy if exists usage_session_days_select_own on private.usage_session_days;
create policy usage_session_days_select_own
  on private.usage_session_days
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists usage_provider_days_select_own on private.usage_provider_days;
create policy usage_provider_days_select_own
  on private.usage_provider_days
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists usage_context_days_select_own on private.usage_context_days;
create policy usage_context_days_select_own
  on private.usage_context_days
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- No client grants; the SELECT policies are defense in depth only.
revoke all on table private.usage_session_days
  from public, anon, authenticated, service_role;
revoke all on table private.usage_provider_days
  from public, anon, authenticated, service_role;
revoke all on table private.usage_context_days
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

create or replace function private.usage_dimensions_fail_v1(p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_reason is null or p_reason not in (
    'invalid_payload', 'payload_too_large', 'date_out_of_range', 'provider_not_allowed'
  ) then
    p_reason := 'invalid_payload';
  end if;
  raise exception using
    errcode = '22023',
    message = 'usage_dimensions_' || p_reason;
end;
$$;

create or replace function private.usage_dimensions_identity_v1()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null or not exists (select 1 from auth.users where id = v_user) then
    raise exception using errcode = '42501', message = 'usage_dimensions_identity_required';
  end if;
  return v_user;
end;
$$;

-- 服务器 UTC 日期 - 90 天：最早仍保留的 local_date。
create or replace function private.usage_dimensions_coverage_start_v1()
returns date
language sql
stable
set search_path = ''
as $$
  select ((pg_catalog.now() at time zone 'UTC')::date - 90);
$$;

-- JSON 整数，范围 [p_min, bigint 上限]；不接受小数、字符串与布尔。
create or replace function private.usage_dimensions_count_ok_v1(p_value jsonb, p_min bigint)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'number' then false
    when (p_value #>> '{}') !~ '^[0-9]{1,19}$' then false
    else (p_value #>> '{}')::numeric between p_min::numeric and 9223372036854775807::numeric
  end;
$$;

-- 可空费用：缺省或 null 表示不可得；否则为 ≥ 0 的 JSON 数字。
create or replace function private.usage_dimensions_cost_ok_v1(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then true
    when pg_catalog.jsonb_typeof(p_value) <> 'number' then false
    else (p_value #>> '{}')::numeric >= 0::numeric
  end;
$$;

create or replace function private.usage_dimensions_text_ok_v1(
  p_value jsonb,
  p_max integer,
  p_optional boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then p_optional
    when pg_catalog.jsonb_typeof(p_value) <> 'string' then false
    else pg_catalog.char_length(p_value #>> '{}') between 1 and p_max
  end;
$$;

create or replace function private.usage_dimensions_clock_ok_v1(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
    and pg_catalog.jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
$$;

-- Parse one day's date: format errors are invalid_payload, out-of-window dates
-- are date_out_of_range (never silently dropped).
create or replace function private.usage_dimensions_day_date_v1(p_value jsonb, p_today date)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_date date;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string'
     or (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform private.usage_dimensions_fail_v1('invalid_payload');
  end if;
  begin
    v_date := (p_value #>> '{}')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    perform private.usage_dimensions_fail_v1('invalid_payload');
  end;
  if v_date < p_today - 90 or v_date > p_today + 1 then
    perform private.usage_dimensions_fail_v1('date_out_of_range');
  end if;
  return v_date;
end;
$$;

-- Validate one dimension's envelope: {"days": [...]} with at most 92 unique dates.
-- Returns the number of rows the dimension will insert.
create or replace function private.validate_usage_dimension_v1(
  p_dimension text,
  p_value jsonb,
  p_today date
)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_day jsonb;
  v_row jsonb;
  v_dates date[] := array[]::date[];
  v_date date;
  v_keys text[];
  v_rows integer := 0;
  v_day_rows integer;
begin
  if pg_catalog.jsonb_typeof(p_value) <> 'object'
     or not (p_value ? 'days')
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_value) as k(key)
       where k.key <> 'days'
     )
     or pg_catalog.jsonb_typeof(p_value -> 'days') <> 'array' then
    perform private.usage_dimensions_fail_v1('invalid_payload');
  end if;
  if pg_catalog.jsonb_array_length(p_value -> 'days') > 92 then
    perform private.usage_dimensions_fail_v1('payload_too_large');
  end if;

  for v_day in
    select d.value from pg_catalog.jsonb_array_elements(p_value -> 'days') as d(value)
  loop
    if pg_catalog.jsonb_typeof(v_day) <> 'object'
       or not (v_day ? 'date')
       or (p_dimension = 'context' and not (v_day ? 'row'))
       or (p_dimension <> 'context' and not (v_day ? 'rows'))
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(v_day) as k(key)
         where k.key <> all(
           case p_dimension
             when 'sessions' then array['date', 'truncated', 'rows']::text[]
             when 'providers' then array['date', 'rows']::text[]
             else array['date', 'row']::text[]
           end
         )
       ) then
      perform private.usage_dimensions_fail_v1('invalid_payload');
    end if;

    v_date := private.usage_dimensions_day_date_v1(v_day -> 'date', p_today);
    if v_date = any(v_dates) then
      perform private.usage_dimensions_fail_v1('invalid_payload');
    end if;
    v_dates := v_dates || v_date;

    if p_dimension = 'context' then
      v_row := v_day -> 'row';
      if pg_catalog.jsonb_typeof(v_row) = 'null' then
        continue;
      end if;
      if pg_catalog.jsonb_typeof(v_row) <> 'object'
         or not (v_row ?& array[
           'requests', 'promptTokens', 'systemBytes', 'toolsBytes', 'historyBytes',
           'toolResultsBytes', 'attachmentsBytes', 'messages', 'toolResults', 'attachments'
         ]::text[])
         or exists (
           select 1 from pg_catalog.jsonb_object_keys(v_row) as k(key)
           where k.key not in (
             'requests', 'promptTokens', 'systemBytes', 'toolsBytes', 'historyBytes',
             'toolResultsBytes', 'attachmentsBytes', 'messages', 'toolResults', 'attachments'
           )
         )
         or not private.usage_dimensions_count_ok_v1(v_row -> 'requests', 1)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'promptTokens', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'systemBytes', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'toolsBytes', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'historyBytes', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'toolResultsBytes', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'attachmentsBytes', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'messages', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'toolResults', 0)
         or not private.usage_dimensions_count_ok_v1(v_row -> 'attachments', 0) then
        perform private.usage_dimensions_fail_v1('invalid_payload');
      end if;
      v_rows := v_rows + 1;
      continue;
    end if;

    if pg_catalog.jsonb_typeof(v_day -> 'rows') <> 'array' then
      perform private.usage_dimensions_fail_v1('invalid_payload');
    end if;
    v_day_rows := pg_catalog.jsonb_array_length(v_day -> 'rows');

    if p_dimension = 'sessions' then
      if v_day ? 'truncated' and (
        pg_catalog.jsonb_typeof(v_day -> 'truncated') <> 'boolean'
        -- 截断的日必然带有行（桌面取前 500 个会话）。
        or ((v_day -> 'truncated') = 'true'::jsonb and v_day_rows = 0)
      ) then
        perform private.usage_dimensions_fail_v1('invalid_payload');
      end if;
      if v_day_rows > 500 then
        perform private.usage_dimensions_fail_v1('payload_too_large');
      end if;
    end if;

    v_keys := array[]::text[];
    for v_row in
      select r.value from pg_catalog.jsonb_array_elements(v_day -> 'rows') as r(value)
    loop
      if p_dimension = 'sessions' then
        if pg_catalog.jsonb_typeof(v_row) <> 'object'
           or not (v_row ?& array['key', 'tool', 'tokens', 'requests', 'firstAt', 'lastAt']::text[])
           or exists (
             select 1 from pg_catalog.jsonb_object_keys(v_row) as k(key)
             where k.key not in (
               'key', 'tool', 'tokens', 'requests', 'cost', 'firstAt', 'lastAt', 'topModel'
             )
           )
           or pg_catalog.jsonb_typeof(v_row -> 'key') <> 'string'
           or (v_row ->> 'key') !~ '^[0-9a-f]{32}$'
           or (v_row ->> 'key') = any(v_keys)
           or not private.usage_dimensions_text_ok_v1(v_row -> 'tool', 128, false)
           or not private.usage_dimensions_text_ok_v1(v_row -> 'topModel', 128, true)
           or not private.usage_dimensions_count_ok_v1(v_row -> 'tokens', 0)
           or not private.usage_dimensions_count_ok_v1(v_row -> 'requests', 1)
           or not private.usage_dimensions_cost_ok_v1(v_row -> 'cost')
           or not private.usage_dimensions_clock_ok_v1(v_row -> 'firstAt')
           or not private.usage_dimensions_clock_ok_v1(v_row -> 'lastAt')
           or (v_row ->> 'firstAt') > (v_row ->> 'lastAt') then
          perform private.usage_dimensions_fail_v1('invalid_payload');
        end if;
        v_keys := v_keys || (v_row ->> 'key');
      else
        if pg_catalog.jsonb_typeof(v_row) <> 'object'
           or not (v_row ?& array['provider', 'input', 'output', 'cached', 'cacheWrite', 'requests']::text[])
           or exists (
             select 1 from pg_catalog.jsonb_object_keys(v_row) as k(key)
             where k.key not in (
               'provider', 'input', 'output', 'cached', 'cacheWrite', 'requests', 'cost'
             )
           )
           or pg_catalog.jsonb_typeof(v_row -> 'provider') <> 'string'
           or (v_row ->> 'provider') = any(v_keys)
           or not private.usage_dimensions_count_ok_v1(v_row -> 'input', 0)
           or not private.usage_dimensions_count_ok_v1(v_row -> 'output', 0)
           or not private.usage_dimensions_count_ok_v1(v_row -> 'cached', 0)
           or not private.usage_dimensions_count_ok_v1(v_row -> 'cacheWrite', 0)
           or not private.usage_dimensions_count_ok_v1(v_row -> 'requests', 1)
           or not private.usage_dimensions_cost_ok_v1(v_row -> 'cost') then
          perform private.usage_dimensions_fail_v1('invalid_payload');
        end if;
        -- 精确匹配规范名（小写），名单外整批拒绝（契约 §2.1）。
        if (v_row ->> 'provider') not in (
          'anthropic', 'ark', 'deepseek', 'gemini', 'glm', 'groq', 'kimi', 'lmstudio',
          'mistral', 'ollama', 'openai', 'openrouter', 'qwen', 'siliconflow', 'xai', 'other'
        ) then
          perform private.usage_dimensions_fail_v1('provider_not_allowed');
        end if;
        v_keys := v_keys || (v_row ->> 'provider');
      end if;
    end loop;
    v_rows := v_rows + v_day_rows;
  end loop;

  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- Write (contract §3.1).
-- ---------------------------------------------------------------------------

create or replace function public.sync_usage_dimensions_v1(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.usage_dimensions_identity_v1();
  v_today date := (pg_catalog.now() at time zone 'UTC')::date;
  v_coverage date := private.usage_dimensions_coverage_start_v1();
  v_machine text;
  v_total integer := 0;
  v_stored_sessions integer := 0;
  v_stored_providers integer := 0;
  v_stored_context integer := 0;
  v_purged integer := 0;
  v_count integer;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    perform private.usage_dimensions_fail_v1('invalid_payload');
  end if;
  if pg_catalog.octet_length(p_payload::text) > 2097152 then
    perform private.usage_dimensions_fail_v1('payload_too_large');
  end if;
  if not (p_payload ?& array['v', 'machine']::text[])
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_payload) as k(key)
       where k.key not in ('v', 'machine', 'sessions', 'providers', 'context')
     )
     or p_payload -> 'v' <> '1'::jsonb
     or not private.usage_dimensions_text_ok_v1(p_payload -> 'machine', 128, false) then
    perform private.usage_dimensions_fail_v1('invalid_payload');
  end if;
  v_machine := p_payload ->> 'machine';

  -- Validate the whole batch before any write.
  if p_payload ? 'sessions' then
    v_total := v_total + private.validate_usage_dimension_v1('sessions', p_payload -> 'sessions', v_today);
  end if;
  if p_payload ? 'providers' then
    v_total := v_total + private.validate_usage_dimension_v1('providers', p_payload -> 'providers', v_today);
  end if;
  if p_payload ? 'context' then
    v_total := v_total + private.validate_usage_dimension_v1('context', p_payload -> 'context', v_today);
  end if;
  if v_total > 10000 then
    perform private.usage_dimensions_fail_v1('payload_too_large');
  end if;

  -- Serialize per owner so concurrent replace-per-day batches never collide.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('usage_dimensions:' || v_user::text, 0)
  );

  if p_payload ? 'sessions' then
    delete from private.usage_session_days s
    where s.user_id = v_user
      and s.machine_id = v_machine
      and s.local_date in (
        select (d.value ->> 'date')::date
        from pg_catalog.jsonb_array_elements(p_payload #> '{sessions,days}') as d(value)
      );
    insert into private.usage_session_days (
      user_id, machine_id, local_date, session_key, tool, tokens, requests, cost_usd,
      first_at, last_at, top_model, truncated
    )
    select
      v_user, v_machine, (d.value ->> 'date')::date, r.value ->> 'key', r.value ->> 'tool',
      (r.value ->> 'tokens')::bigint, (r.value ->> 'requests')::bigint,
      (r.value ->> 'cost')::numeric, r.value ->> 'firstAt', r.value ->> 'lastAt',
      r.value ->> 'topModel', coalesce((d.value ->> 'truncated')::boolean, false)
    from pg_catalog.jsonb_array_elements(p_payload #> '{sessions,days}') as d(value)
    cross join lateral pg_catalog.jsonb_array_elements(d.value -> 'rows') as r(value);
    get diagnostics v_stored_sessions = row_count;
  end if;

  if p_payload ? 'providers' then
    delete from private.usage_provider_days p
    where p.user_id = v_user
      and p.machine_id = v_machine
      and p.local_date in (
        select (d.value ->> 'date')::date
        from pg_catalog.jsonb_array_elements(p_payload #> '{providers,days}') as d(value)
      );
    insert into private.usage_provider_days (
      user_id, machine_id, local_date, provider, input_tokens, output_tokens,
      cached_tokens, cache_write_tokens, requests, cost_usd
    )
    select
      v_user, v_machine, (d.value ->> 'date')::date, r.value ->> 'provider',
      (r.value ->> 'input')::bigint, (r.value ->> 'output')::bigint,
      (r.value ->> 'cached')::bigint, (r.value ->> 'cacheWrite')::bigint,
      (r.value ->> 'requests')::bigint, (r.value ->> 'cost')::numeric
    from pg_catalog.jsonb_array_elements(p_payload #> '{providers,days}') as d(value)
    cross join lateral pg_catalog.jsonb_array_elements(d.value -> 'rows') as r(value);
    get diagnostics v_stored_providers = row_count;
  end if;

  if p_payload ? 'context' then
    delete from private.usage_context_days c
    where c.user_id = v_user
      and c.machine_id = v_machine
      and c.local_date in (
        select (d.value ->> 'date')::date
        from pg_catalog.jsonb_array_elements(p_payload #> '{context,days}') as d(value)
      );
    insert into private.usage_context_days (
      user_id, machine_id, local_date, requests, prompt_tokens, system_bytes, tools_bytes,
      history_bytes, tool_results_bytes, attachments_bytes, messages, tool_results, attachments
    )
    select
      v_user, v_machine, (d.value ->> 'date')::date,
      (d.value #>> '{row,requests}')::bigint, (d.value #>> '{row,promptTokens}')::bigint,
      (d.value #>> '{row,systemBytes}')::bigint, (d.value #>> '{row,toolsBytes}')::bigint,
      (d.value #>> '{row,historyBytes}')::bigint, (d.value #>> '{row,toolResultsBytes}')::bigint,
      (d.value #>> '{row,attachmentsBytes}')::bigint, (d.value #>> '{row,messages}')::bigint,
      (d.value #>> '{row,toolResults}')::bigint, (d.value #>> '{row,attachments}')::bigint
    from pg_catalog.jsonb_array_elements(p_payload #> '{context,days}') as d(value)
    where pg_catalog.jsonb_typeof(d.value -> 'row') = 'object';
    get diagnostics v_stored_context = row_count;
  end if;

  -- 顺带删除本人所有设备的过期行。
  delete from private.usage_session_days s
  where s.user_id = v_user and s.local_date < v_coverage;
  get diagnostics v_count = row_count;
  v_purged := v_purged + v_count;
  delete from private.usage_provider_days p
  where p.user_id = v_user and p.local_date < v_coverage;
  get diagnostics v_count = row_count;
  v_purged := v_purged + v_count;
  delete from private.usage_context_days c
  where c.user_id = v_user and c.local_date < v_coverage;
  get diagnostics v_count = row_count;
  v_purged := v_purged + v_count;

  return pg_catalog.jsonb_build_object(
    'stored', pg_catalog.jsonb_build_object(
      'sessions', v_stored_sessions,
      'providers', v_stored_providers,
      'context', v_stored_context
    ),
    'purged', v_purged,
    'retentionDays', 90
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Clear (contract §3.2).
-- ---------------------------------------------------------------------------

create or replace function public.clear_usage_dimension_v1(p_dimension text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.usage_dimensions_identity_v1();
  v_count integer;
begin
  if p_dimension is null or p_dimension not in ('sessions', 'providers', 'context') then
    perform private.usage_dimensions_fail_v1('invalid_payload');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('usage_dimensions:' || v_user::text, 0)
  );

  if p_dimension = 'sessions' then
    delete from private.usage_session_days s where s.user_id = v_user;
  elsif p_dimension = 'providers' then
    delete from private.usage_provider_days p where p.user_id = v_user;
  else
    delete from private.usage_context_days c where c.user_id = v_user;
  end if;
  get diagnostics v_count = row_count;

  return pg_catalog.jsonb_build_object('deleted', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Read (contract §4).
-- ---------------------------------------------------------------------------

create or replace function public.get_usage_dimensions_v1(p_query jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.usage_dimensions_identity_v1();
  v_query jsonb;
  v_range text;
  v_timezone text;
  v_today date;
  v_coverage date := private.usage_dimensions_coverage_start_v1();
  v_start date;
  v_end date;
  v_from date;
  v_machines text[];
  v_tools text[];
  v_model_filtered boolean;
  v_tool_filtered boolean;
  v_meta jsonb;
  v_sessions jsonb;
  v_providers jsonb;
  v_context jsonb;
begin
  v_query := private.tokenledger_normalize_query_v2(p_query);
  v_range := v_query ->> 'range';
  v_timezone := v_query ->> 'timezone';
  v_today := (pg_catalog.now() at time zone v_timezone)::date;

  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_machines
  from pg_catalog.jsonb_array_elements_text(v_query -> 'machines') as e(value);
  select coalesce(pg_catalog.array_agg(e.value), array[]::text[])
    into v_tools
  from pg_catalog.jsonb_array_elements_text(v_query -> 'tools') as e(value);
  -- 云端行不带逐模型拆分，也没有可做字面搜索的会话 ID：带模型筛选或搜索时
  -- 三个维度都标 filtered，不拿未筛选的数当筛选结果。
  v_model_filtered := pg_catalog.jsonb_array_length(v_query -> 'models') > 0
    or (v_query ->> 'search') is not null;
  v_tool_filtered := pg_catalog.cardinality(v_tools) > 0;

  if v_range = 'custom' then
    v_start := (v_query ->> 'start')::date;
    v_end := least((v_query ->> 'end')::date, v_today);
  else
    v_end := v_today;
    v_start := case v_range
      when 'today' then v_today
      when 'week' then pg_catalog.date_trunc('week', v_today::timestamp)::date
      when 'month' then pg_catalog.date_trunc('month', v_today::timestamp)::date
      when 'year' then pg_catalog.date_trunc('year', v_today::timestamp)::date
      else v_coverage
    end;
  end if;
  -- 早于保留下限的部分没有数据；尚未被清理的过期行也不读。
  v_from := greatest(v_start, v_coverage);

  v_meta := pg_catalog.jsonb_build_object(
    'source', 'cloud',
    'start', v_start::text,
    'end', v_end::text,
    'timezone', v_timezone,
    'retentionDays', 90,
    'coverageStart', v_coverage::text
  );

  -- Sessions --------------------------------------------------------------
  if v_model_filtered then
    v_sessions := '{"state":"filtered"}'::jsonb;
  else
    with base as materialized (
      select s.machine_id, s.session_key, s.local_date, s.tool, s.tokens, s.requests,
        s.cost_usd, s.first_at, s.last_at, s.top_model, s.truncated
      from private.usage_session_days s
      where s.user_id = v_user
        and s.local_date between v_from and v_end
        and (pg_catalog.cardinality(v_machines) = 0 or s.machine_id = any(v_machines))
    ), merged as (
      select
        b.machine_id,
        b.session_key,
        pg_catalog.min(b.tool) as tool,
        pg_catalog.sum(b.tokens) as tokens,
        pg_catalog.sum(b.requests) as requests,
        case when pg_catalog.bool_or(b.cost_usd is null) then null
          else pg_catalog.sum(b.cost_usd) end as cost,
        pg_catalog.count(*) as days,
        pg_catalog.min(b.local_date) as first_date,
        pg_catalog.max(b.local_date) as last_date,
        (pg_catalog.array_agg(b.first_at order by b.local_date))[1] as first_at,
        (pg_catalog.array_agg(b.last_at order by b.local_date desc))[1] as last_at,
        -- 合并后 Token 最多那天的 top_model；同 Token 取较晚的一天。
        (pg_catalog.array_agg(b.top_model order by b.tokens desc, b.local_date desc))[1] as top_model
      from base b
      where pg_catalog.cardinality(v_tools) = 0 or b.tool = any(v_tools)
      group by b.machine_id, b.session_key
    ), ranked as (
      select m.*
      from merged m
      order by m.tokens desc, m.session_key collate "C", m.machine_id collate "C"
      limit 100
    )
    select pg_catalog.jsonb_build_object(
      'state', case when (select pg_catalog.count(*) from merged) > 0 then 'ok' else 'empty' end,
      'sessionCount', (select pg_catalog.count(*) from merged),
      'truncatedDays', (
        select pg_catalog.count(*) from (
          select distinct b.machine_id, b.local_date from base b where b.truncated
        ) t
      ),
      'sessionLimit', 100,
      'rows', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', r.session_key,
            'machine', r.machine_id,
            'tool', r.tool,
            'tokens', r.tokens,
            'requests', r.requests,
            'cost', r.cost,
            'days', r.days,
            'firstDate', r.first_date::text,
            'lastDate', r.last_date::text,
            'firstAt', r.first_at,
            'lastAt', r.last_at,
            'topModel', r.top_model
          )
          order by r.tokens desc, r.session_key collate "C", r.machine_id collate "C"
        )
        from ranked r
      ), '[]'::jsonb)
    ) into v_sessions;
  end if;

  -- Providers -------------------------------------------------------------
  if v_model_filtered or v_tool_filtered then
    v_providers := '{"state":"filtered"}'::jsonb;
  else
    with grouped as (
      select
        p.provider,
        pg_catalog.sum(p.input_tokens) as input,
        pg_catalog.sum(p.output_tokens) as output,
        pg_catalog.sum(p.cached_tokens) as cached,
        pg_catalog.sum(p.cache_write_tokens) as cache_write,
        pg_catalog.sum(p.requests) as requests,
        case when pg_catalog.bool_or(p.cost_usd is null) then null
          else pg_catalog.sum(p.cost_usd) end as cost
      from private.usage_provider_days p
      where p.user_id = v_user
        and p.local_date between v_from and v_end
        and (pg_catalog.cardinality(v_machines) = 0 or p.machine_id = any(v_machines))
      group by p.provider
    )
    select pg_catalog.jsonb_build_object(
      'state', case when pg_catalog.count(*) > 0 then 'ok' else 'empty' end,
      'rows', coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'provider', g.provider,
            'input', g.input,
            'output', g.output,
            'cached', g.cached,
            'cacheWrite', g.cache_write,
            'total', g.input + g.output,
            'requests', g.requests,
            'cost', g.cost
          )
          order by (g.provider = 'other'), g.input + g.output desc, g.provider collate "C"
        ),
        '[]'::jsonb
      )
    ) into v_providers
    from grouped g;
  end if;

  -- Context composition ---------------------------------------------------
  if v_model_filtered or v_tool_filtered then
    v_context := '{"state":"filtered"}'::jsonb;
  else
    select pg_catalog.jsonb_build_object(
      'state', case when pg_catalog.count(*) > 0 then 'ok' else 'empty' end,
      'requests', coalesce(pg_catalog.sum(c.requests), 0),
      'promptTokens', coalesce(pg_catalog.sum(c.prompt_tokens), 0),
      'systemBytes', coalesce(pg_catalog.sum(c.system_bytes), 0),
      'toolsBytes', coalesce(pg_catalog.sum(c.tools_bytes), 0),
      'historyBytes', coalesce(pg_catalog.sum(c.history_bytes), 0),
      'toolResultsBytes', coalesce(pg_catalog.sum(c.tool_results_bytes), 0),
      'attachmentsBytes', coalesce(pg_catalog.sum(c.attachments_bytes), 0),
      'messages', coalesce(pg_catalog.sum(c.messages), 0),
      'toolResults', coalesce(pg_catalog.sum(c.tool_results), 0),
      'attachments', coalesce(pg_catalog.sum(c.attachments), 0)
    ) into v_context
    from private.usage_context_days c
    where c.user_id = v_user
      and c.local_date between v_from and v_end
      and (pg_catalog.cardinality(v_machines) = 0 or c.machine_id = any(v_machines));
  end if;

  return pg_catalog.jsonb_build_object(
    'meta', v_meta,
    'sessions', v_sessions,
    'providers', v_providers,
    'contextComposition', v_context
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention: owner-independent daily purge (contract §1).
-- ---------------------------------------------------------------------------

create or replace function private.purge_expired_usage_dimensions_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_coverage date := private.usage_dimensions_coverage_start_v1();
  v_total integer := 0;
  v_count integer;
begin
  delete from private.usage_session_days s where s.local_date < v_coverage;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;
  delete from private.usage_provider_days p where p.local_date < v_coverage;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;
  delete from private.usage_context_days c where c.local_date < v_coverage;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;
  return v_total;
end;
$$;

create extension if not exists pg_cron;

select cron.schedule(
  'tokenledger-usage-dimensions-daily-purge',
  '23 3 * * *',
  $cron$select private.purge_expired_usage_dimensions_v1();$cron$
);

-- ---------------------------------------------------------------------------
-- Grants: only the three public RPCs, only to authenticated.
-- ---------------------------------------------------------------------------

revoke execute on function private.usage_dimensions_fail_v1(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.usage_dimensions_identity_v1()
  from public, anon, authenticated, service_role;
revoke execute on function private.usage_dimensions_coverage_start_v1()
  from public, anon, authenticated, service_role;
revoke execute on function private.usage_dimensions_count_ok_v1(jsonb, bigint)
  from public, anon, authenticated, service_role;
revoke execute on function private.usage_dimensions_cost_ok_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.usage_dimensions_text_ok_v1(jsonb, integer, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function private.usage_dimensions_clock_ok_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.usage_dimensions_day_date_v1(jsonb, date)
  from public, anon, authenticated, service_role;
revoke execute on function private.validate_usage_dimension_v1(text, jsonb, date)
  from public, anon, authenticated, service_role;
revoke execute on function private.purge_expired_usage_dimensions_v1()
  from public, anon, authenticated, service_role;

revoke execute on function public.sync_usage_dimensions_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.clear_usage_dimension_v1(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_usage_dimensions_v1(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.sync_usage_dimensions_v1(jsonb) to authenticated;
grant execute on function public.clear_usage_dimension_v1(text) to authenticated;
grant execute on function public.get_usage_dimensions_v1(jsonb) to authenticated;

comment on table private.usage_session_days
  is 'Per owner device local-day session aggregates uploaded by desktop (usage-dimensions-cloud-v1); 90-day retention.';
comment on table private.usage_provider_days
  is 'Per owner device local-day gateway provider aggregates, whitelisted provider names only (usage-dimensions-cloud-v1); 90-day retention.';
comment on table private.usage_context_days
  is 'Per owner device local-day context composition sizes and counts (usage-dimensions-cloud-v1); 90-day retention.';
comment on function public.sync_usage_dimensions_v1(jsonb)
  is 'Replace the authenticated owner''s per-day session, provider and context rows for one machine; purges rows older than 90 days.';
comment on function public.clear_usage_dimension_v1(text)
  is 'Delete all of the authenticated owner''s rows for one usage dimension across devices.';
comment on function public.get_usage_dimensions_v1(jsonb)
  is 'Read the authenticated owner''s session list, provider split and context composition for a Stats v2 query (cloud, last 90 days).';
