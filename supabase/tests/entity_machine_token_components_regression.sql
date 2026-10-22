\set ON_ERROR_STOP on

begin;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '71370000-0000-4000-8000-000000000001',
    'entity-machine-components@example.invalid',
    pg_catalog.now(),
    '{}'::jsonb,
    '{}'::jsonb,
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '71370000-0000-4000-8000-000000000002',
    'entity-machine-components-other@example.invalid',
    pg_catalog.now(),
    '{}'::jsonb,
    '{}'::jsonb,
    pg_catalog.now(),
    pg_catalog.now()
  );

insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, requests
) values
  (
    '71370000-0000-4000-8000-000000000001', 'FixtureTool', 'FixtureModel',
    100, 20, 7, 2,
    pg_catalog.to_char(
      greatest(
        pg_catalog.now() at time zone 'UTC' - interval '5 minutes',
        pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'entity-machine-components-a', 'entity-machine-components-a', 0.10, 'machine-positive', 1
  ),
  (
    '71370000-0000-4000-8000-000000000001', 'FixtureTool', 'FixtureModel',
    50, 10, 4, 1,
    pg_catalog.to_char(
      greatest(
        pg_catalog.now() at time zone 'UTC' - interval '5 minutes',
        pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'entity-machine-components-b', 'entity-machine-components-b', 0.05, 'machine-positive', 1
  ),
  (
    '71370000-0000-4000-8000-000000000001', 'FixtureTool', 'FixtureModel',
    0, 0, 0, 0,
    pg_catalog.to_char(
      greatest(
        pg_catalog.now() at time zone 'UTC' - interval '5 minutes',
        pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'entity-machine-components-zero', 'entity-machine-components-zero', 0, 'machine-zero', 1
  ),
  (
    '71370000-0000-4000-8000-000000000001', 'FixtureTool', 'FixtureModel',
    10, 5, 2, 1,
    pg_catalog.to_char(
      greatest(
        pg_catalog.now() at time zone 'UTC' - interval '5 minutes',
        pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'entity-machine-components-secondary', 'entity-machine-components-secondary', 0.01, 'machine-secondary', 1
  ),
  (
    '71370000-0000-4000-8000-000000000002', 'FixtureTool', 'FixtureModel',
    9000, 1000, 500, 100,
    pg_catalog.to_char(
      greatest(
        pg_catalog.now() at time zone 'UTC' - interval '5 minutes',
        pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC')
      ),
      'YYYY-MM-DD HH24:MI:SS'
    ),
    'entity-machine-components-other-user', 'entity-machine-components-other-user', 10, 'machine-positive', 1
  );

do $permissions$
begin
  if pg_catalog.to_regprocedure(
    'public.get_usage_entity_dashboard_v1(uuid,text,text,text,text,text)'
  ) is null then
    raise exception 'legacy entity dashboard signature disappeared';
  end if;
  if pg_catalog.has_function_privilege(
    'anon',
    'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)',
    'execute'
  ) then
    raise exception 'anon unexpectedly has entity dashboard v2 EXECUTE';
  end if;
  if not pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)',
    'execute'
  ) or not pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_usage_entity_dashboard_v1(uuid,text,text,text,text,text)',
    'execute'
  ) then
    raise exception 'authenticated entity dashboard EXECUTE compatibility changed';
  end if;
end;
$permissions$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '71370000-0000-4000-8000-000000000001',
  true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $regression$
declare
  v_result jsonb;
  v_positive jsonb;
  v_secondary jsonb;
  v_zero jsonb;
  v_empty jsonb;
  v_legacy jsonb;
  v_tool jsonb;
  v_model jsonb;
begin
  v_result := public.get_usage_entity_dashboard_v2(
    '71370000-0000-4000-8000-000000000001',
    '{"range":"today","timezone":"UTC","machines":[],"tools":[],"models":[],"search":null,"tokenMode":"effective"}'::jsonb,
    '{"kind":"model","id":"FixtureModel"}'::jsonb,
    null,
    20
  );

  select e.item into v_positive
  from pg_catalog.jsonb_array_elements(v_result #> '{composition,machines}') as e(item)
  where e.item ->> 'value' = 'machine-positive';
  select e.item into v_zero
  from pg_catalog.jsonb_array_elements(v_result #> '{composition,machines}') as e(item)
  where e.item ->> 'value' = 'machine-zero';
  select e.item into v_secondary
  from pg_catalog.jsonb_array_elements(v_result #> '{composition,machines}') as e(item)
  where e.item ->> 'value' = 'machine-secondary';
  select e.item into v_tool
  from pg_catalog.jsonb_array_elements(v_result #> '{composition,tools}') as e(item)
  where e.item ->> 'value' = 'FixtureTool';
  select e.item into v_model
  from pg_catalog.jsonb_array_elements(v_result #> '{composition,models}') as e(item)
  where e.item ->> 'value' = 'FixtureModel';

  if pg_catalog.jsonb_array_length(v_result #> '{composition,machines}') is distinct from 3
     or v_positive is null
     or v_secondary is null
     or v_zero is null then
    raise exception 'entity machine composition rows are missing: %', v_result #> '{composition,machines}';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_result #> '{composition,machines}') as e(item)
    where not (e.item ?& array['tokens', 'inputTokens', 'outputTokens', 'cachedTokens'])
       or pg_catalog.jsonb_typeof(e.item -> 'tokens') is distinct from 'number'
       or pg_catalog.jsonb_typeof(e.item -> 'inputTokens') is distinct from 'number'
       or pg_catalog.jsonb_typeof(e.item -> 'outputTokens') is distinct from 'number'
       or pg_catalog.jsonb_typeof(e.item -> 'cachedTokens') is distinct from 'number'
       or (e.item ->> 'tokens')::bigint is distinct from
          (e.item ->> 'inputTokens')::bigint + (e.item ->> 'outputTokens')::bigint
  ) then
    raise exception 'entity machine components are absent, non-numeric, or violate effective Token: %',
      v_result #> '{composition,machines}';
  end if;

  if (v_positive ->> 'tokens')::bigint is distinct from 180
     or (v_positive ->> 'inputTokens')::bigint is distinct from 150
     or (v_positive ->> 'outputTokens')::bigint is distinct from 30
     or (v_positive ->> 'cachedTokens')::bigint is distinct from 11
     or (v_positive ->> 'tokens')::bigint =
        (v_positive ->> 'inputTokens')::bigint
        + (v_positive ->> 'outputTokens')::bigint
        + (v_positive ->> 'cachedTokens')::bigint then
    raise exception 'cache was merged into effective Token or positive aggregates changed: %', v_positive;
  end if;

  if v_result #>> '{composition,machines,0,value}' is distinct from 'machine-positive'
     or v_result #>> '{composition,machines,1,value}' is distinct from 'machine-secondary'
     or v_result #>> '{composition,machines,2,value}' is distinct from 'machine-zero'
     or (v_secondary ->> 'tokens')::bigint is distinct from 15
     or (v_secondary ->> 'cachedTokens')::bigint is distinct from 2 then
    raise exception 'multi-machine aggregation or deterministic ordering changed: %',
      v_result #> '{composition,machines}';
  end if;

  if v_tool is null
     or v_model is null
     or (v_tool ->> 'tokens')::bigint is distinct from 195
     or (v_model ->> 'tokens')::bigint is distinct from 195
     or (v_tool ->> 'inputTokens')::bigint is distinct from 160
     or (v_model ->> 'inputTokens')::bigint is distinct from 160
     or (v_tool ->> 'outputTokens')::bigint is distinct from 35
     or (v_model ->> 'outputTokens')::bigint is distinct from 35
     or (v_tool ->> 'cachedTokens')::bigint is distinct from 13
     or (v_model ->> 'cachedTokens')::bigint is distinct from 13
     or (select pg_catalog.sum((e.item ->> 'tokens')::bigint)
         from pg_catalog.jsonb_array_elements(v_result #> '{composition,machines}') as e(item))
        is distinct from (v_model ->> 'tokens')::bigint
     or (select pg_catalog.sum((e.item ->> 'cachedTokens')::bigint)
         from pg_catalog.jsonb_array_elements(v_result #> '{composition,machines}') as e(item))
        is distinct from (v_model ->> 'cachedTokens')::bigint then
    raise exception 'machine cached/effective semantics diverged from entity tool/model composition: %',
      v_result -> 'composition';
  end if;

  if (v_zero ->> 'tokens')::bigint is distinct from 0
     or (v_zero ->> 'inputTokens')::bigint is distinct from 0
     or (v_zero ->> 'outputTokens')::bigint is distinct from 0
     or (v_zero ->> 'cachedTokens')::bigint is distinct from 0 then
    raise exception 'explicit zero machine components were not preserved: %', v_zero;
  end if;

  v_empty := public.get_usage_entity_dashboard_v2(
    '71370000-0000-4000-8000-000000000001',
    '{"range":"today","timezone":"UTC","machines":[],"tools":[],"models":[],"search":null,"tokenMode":"effective"}'::jsonb,
    '{"kind":"model","id":"missing-model"}'::jsonb,
    null,
    20
  );
  if v_empty #> '{composition,machines}' is distinct from '[]'::jsonb then
    raise exception 'missing entity must remain an empty composition, not a synthetic zero row: %',
      v_empty #> '{composition,machines}';
  end if;

  begin
    perform public.get_usage_entity_dashboard_v2(
      '71370000-0000-4000-8000-000000000002',
      '{"range":"today","timezone":"UTC"}'::jsonb,
      '{"kind":"model","id":"FixtureModel"}'::jsonb,
      null,
      20
    );
    raise exception 'cross-user entity dashboard unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  v_legacy := public.get_usage_entity_dashboard_v1(
    '71370000-0000-4000-8000-000000000001',
    'today',
    null,
    null,
    'FixtureModel',
    'UTC'
  );
  if v_legacy #>> '{entity,kind}' is distinct from 'model'
     or (v_legacy #>> '{summary,totalTokens}')::bigint is distinct from 195 then
    raise exception 'legacy entity dashboard behavior changed: %', v_legacy;
  end if;
end;
$regression$;

reset role;

set local role anon;
do $anon_denied$
begin
  begin
    perform public.get_usage_entity_dashboard_v2(
      '71370000-0000-4000-8000-000000000001',
      '{"range":"today","timezone":"UTC"}'::jsonb,
      '{"kind":"model","id":"FixtureModel"}'::jsonb,
      null,
      20
    );
    raise exception 'anon entity dashboard unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$anon_denied$;

reset role;

rollback;
