\set ON_ERROR_STOP on

begin;

insert into auth.users (
  id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('33333333-3333-3333-3333-333333333333', 'custom-one@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('44444444-4444-4444-4444-444444444444', 'custom-two@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.token_logs (
  user_id, tool, model, input_tokens, output_tokens, cached_tokens,
  cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, requests
) values
  ('33333333-3333-3333-3333-333333333333', 'CustomTool', 'CustomModel', 100, 20, 5, 1,
   '2026-03-08 00:00:00', 'custom-start', 'custom-start', 0.10, 'custom-mac', 1),
  ('33333333-3333-3333-3333-333333333333', 'CustomTool', 'CustomModel', 200, 30, 6, 2,
   '2026-03-08 23:59:59', 'custom-end', 'custom-end', 0.20, 'custom-mac', 2),
  ('33333333-3333-3333-3333-333333333333', 'CustomTool', 'CustomModel', 400, 40, 7, 3,
   '2026-03-09 00:00:00', 'outside-after', 'outside-after', 0.40, 'custom-mac', 4),
  ('33333333-3333-3333-3333-333333333333', 'CustomTool', 'CustomModel', 50, 10, 0, 0,
   '2026-03-07 00:00:00', 'previous-start', 'previous-start', 0.05, 'custom-mac', 1),
  ('33333333-3333-3333-3333-333333333333', 'CustomTool', 'CustomModel', 60, 10, 0, 0,
   '2026-03-07 23:59:59', 'previous-end', 'previous-end', 0.06, 'custom-mac', 1),
  ('44444444-4444-4444-4444-444444444444', 'CustomTool', 'CustomModel', 9000, 1000, 0, 0,
   '2026-03-08 12:00:00', 'other-user', 'other-user', 10.0, 'custom-mac', 1),
  ('33333333-3333-3333-3333-333333333333', 'CustomTool', 'CustomModel', 70, 5, 0, 0,
   '2025-12-31 12:00:00', 'cross-year-a', 'cross-year-a', 0.07, 'custom-mac', 1),
  ('33333333-3333-3333-3333-333333333333', 'CustomTool', 'CustomModel', 80, 5, 0, 0,
   '2026-01-02 12:00:00', 'cross-year-b', 'cross-year-b', 0.08, 'custom-mac', 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  q jsonb := '{"range":"custom","start":"2026-03-08","end":"2026-03-08","timezone":"America/New_York","machines":[],"tools":[],"models":[],"search":null,"tokenMode":"effective"}'::jsonb;
  q_next jsonb := '{"range":"custom","start":"2026-03-09","end":"2026-03-09","timezone":"America/New_York","machines":[],"tools":[],"models":[],"search":null,"tokenMode":"effective"}'::jsonb;
  dashboard jsonb;
  comparison jsonb;
  details jsonb;
  entity_result jsonb;
  cursor_value text;
  old_result jsonb;
  empty_result jsonb;
  empty_dashboard jsonb;
  cross_year jsonb;
  cross_dashboard jsonb;
  future_window jsonb;
  bad_query jsonb;
  local_today date := (now() at time zone 'America/New_York')::date;
begin
  dashboard := public.get_dashboard_stats_v2('33333333-3333-3333-3333-333333333333', q);
  if dashboard #>> '{meta,query,start}' <> '2026-03-08'
     or dashboard #>> '{meta,query,end}' <> '2026-03-08'
     or dashboard #>> '{meta,range}' <> 'custom' then
    raise exception 'custom dashboard echo mismatch: %', dashboard #> '{meta}';
  end if;
  if (dashboard #>> '{summary,totalTokens}')::bigint <> 350 then
    raise exception 'custom dashboard included rows outside the day or another user: %', dashboard #> '{summary}';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(dashboard -> 'heatmap')) <> 1
     or (dashboard #>> '{heatmap,2026-03-08}')::bigint <> 350 then
    raise exception 'custom dashboard heatmap escaped the selected day: %', dashboard -> 'heatmap';
  end if;
  if dashboard #>> '{trends,0,date}' is null then
    raise exception 'custom single day must return hour trends';
  end if;
  if dashboard #> '{dailyCosts,coverage}' <> '{"start":"2026-03-08","end":"2026-03-08","timezone":"America/New_York","state":"complete"}'::jsonb
     or pg_catalog.jsonb_array_length(dashboard #> '{dailyCosts,days}') is distinct from 1
     or dashboard #>> '{dailyCosts,days,0,date}' is distinct from '2026-03-08'
     or dashboard #>> '{dailyCosts,days,0,status}' is distinct from 'recorded-estimate'
     or (dashboard #>> '{dailyCosts,days,0,amountUsd}')::double precision is distinct from 0.30 then
    raise exception 'custom daily costs lost DST-local coverage or amount: %', dashboard -> 'dailyCosts';
  end if;

  comparison := public.get_usage_comparison_v2('33333333-3333-3333-3333-333333333333', q);
  if comparison #>> '{window,kind}' <> 'periodOverPeriod'
     or comparison #>> '{window,bucket}' <> 'hour'
     or (comparison #>> '{current,summary,totalTokens}')::bigint <> 350
     or (comparison #>> '{previous,summary,totalTokens}')::bigint <> 130 then
    raise exception 'custom comparison mismatch: %', comparison;
  end if;
  -- America/New_York starts DST on 2026-03-08. The wall-clock day remains
  -- 00:00:00..23:59:59 while the attached offsets differ across the boundary.
  if ((comparison #>> '{window,currentStart}')::timestamptz at time zone 'America/New_York')
       <> timestamp '2026-03-08 00:00:00'
     or ((comparison #>> '{window,currentEnd}')::timestamptz at time zone 'America/New_York')
       <> timestamp '2026-03-08 23:59:59'
     or ((comparison #>> '{window,previousStart}')::timestamptz at time zone 'America/New_York')
       <> timestamp '2026-03-07 00:00:00'
     or ((comparison #>> '{window,previousEnd}')::timestamptz at time zone 'America/New_York')
       <> timestamp '2026-03-07 23:59:59'
     or extract(epoch from (
       (comparison #>> '{window,currentEnd}')::timestamptz
       - (comparison #>> '{window,currentStart}')::timestamptz
     )) <> 82799 then
    raise exception 'DST wall-clock boundaries are incorrect: %', comparison #> '{window}';
  end if;

  details := public.get_usage_details_v2(
    '33333333-3333-3333-3333-333333333333', q, null, 1
  );
  if (details ->> 'totalCount')::bigint <> 2
     or (details #>> '{filteredSummary,totalTokens}')::bigint <> 350 then
    raise exception 'custom details total/summary mismatch: %', details;
  end if;
  cursor_value := details ->> 'nextCursor';
  if cursor_value is null then raise exception 'custom details did not produce a cursor'; end if;
  begin
    perform public.get_usage_details_v2(
      '33333333-3333-3333-3333-333333333333', q_next, cursor_value, 1
    );
    raise exception 'cursor from another custom day unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;

  entity_result := public.get_usage_entity_dashboard_v2(
    '33333333-3333-3333-3333-333333333333', q,
    '{"kind":"model","id":"CustomModel"}'::jsonb, null, 50
  );
  if (entity_result #>> '{summary,totalTokens}')::bigint <> 350
     or entity_result #>> '{meta,query,start}' <> '2026-03-08'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entity_result -> 'heatmap')) <> 1 then
    raise exception 'custom entity range mismatch: %', entity_result;
  end if;

  empty_result := public.get_usage_details_v2(
    '33333333-3333-3333-3333-333333333333',
    '{"range":"custom","start":"2026-02-01","end":"2026-02-02","timezone":"UTC"}'::jsonb,
    null, 50
  );
  if (empty_result ->> 'totalCount')::bigint <> 0
     or (empty_result #>> '{filteredSummary,totalTokens}')::bigint <> 0 then
    raise exception 'empty custom range is not an explicit zero result: %', empty_result;
  end if;
  empty_dashboard := public.get_dashboard_stats_v2(
    '33333333-3333-3333-3333-333333333333',
    '{"range":"custom","start":"2026-02-01","end":"2026-02-02","timezone":"UTC"}'::jsonb
  );
  if empty_dashboard #> '{dailyCosts,days}' <> '[]'::jsonb
     or empty_dashboard #>> '{dailyCosts,coverage,start}' is distinct from '2026-02-01'
     or empty_dashboard #>> '{dailyCosts,coverage,end}' is distinct from '2026-02-02' then
    raise exception 'empty custom daily costs must retain trusted coverage: %',
      empty_dashboard -> 'dailyCosts';
  end if;

  cross_year := public.get_usage_comparison_v2(
    '33333333-3333-3333-3333-333333333333',
    '{"range":"custom","start":"2025-12-31","end":"2026-01-02","timezone":"America/New_York"}'::jsonb
  );
  if cross_year #>> '{window,bucket}' <> 'day'
     or ((cross_year #>> '{window,currentStart}')::timestamptz at time zone 'America/New_York')
       <> timestamp '2025-12-31 00:00:00'
     or ((cross_year #>> '{window,previousStart}')::timestamptz at time zone 'America/New_York')
       <> timestamp '2025-12-28 00:00:00' then
    raise exception 'cross-year custom range is incorrect: %', cross_year #> '{window}';
  end if;
  cross_dashboard := public.get_dashboard_stats_v2(
    '33333333-3333-3333-3333-333333333333',
    '{"range":"custom","start":"2025-12-31","end":"2026-01-02","timezone":"America/New_York"}'::jsonb
  );
  if (cross_dashboard #>> '{heatmap,2025-12-31}')::bigint <> 75
     or (cross_dashboard #>> '{heatmap,2026-01-02}')::bigint <> 85
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(cross_dashboard -> 'heatmap')) <> 2 then
    raise exception 'cross-year dashboard heatmap lost or leaked dates: %', cross_dashboard -> 'heatmap';
  end if;
  if cross_dashboard #>> '{dailyCosts,coverage,start}' is distinct from '2025-12-31'
     or cross_dashboard #>> '{dailyCosts,coverage,end}' is distinct from '2026-01-02'
     or pg_catalog.jsonb_array_length(cross_dashboard #> '{dailyCosts,days}') is distinct from 2
     or cross_dashboard #>> '{dailyCosts,days,0,date}' is distinct from '2025-12-31'
     or cross_dashboard #>> '{dailyCosts,days,1,date}' is distinct from '2026-01-02' then
    raise exception 'cross-year daily costs are not sorted and query-bound: %',
      cross_dashboard -> 'dailyCosts';
  end if;

  future_window := public.get_usage_comparison_v2(
    '33333333-3333-3333-3333-333333333333',
    pg_catalog.jsonb_build_object(
      'range', 'custom', 'start', local_today, 'end', local_today + 30,
      'timezone', 'America/New_York'
    )
  );
  if pg_catalog.abs(extract(epoch from (
    (future_window #>> '{window,currentEnd}')::timestamptz - pg_catalog.now()
  ))) > 2 then
    raise exception 'future custom end was not clipped to now: %', future_window #> '{window}';
  end if;
  dashboard := public.get_dashboard_stats_v2(
    '33333333-3333-3333-3333-333333333333',
    pg_catalog.jsonb_build_object(
      'range', 'custom', 'start', local_today, 'end', local_today + 30,
      'timezone', 'America/New_York'
    )
  );
  if dashboard #>> '{dailyCosts,coverage,start}' is distinct from local_today::text
     or dashboard #>> '{dailyCosts,coverage,end}' is distinct from local_today::text then
    raise exception 'future custom daily coverage was not clipped to today: %',
      dashboard #> '{dailyCosts,coverage}';
  end if;

  -- Preset requests retain their legacy query shape even if callers attach dates.
  if (public.get_dashboard_stats_v2(
    '33333333-3333-3333-3333-333333333333',
    '{"range":"week","start":"2026-03-01","end":"2026-03-08"}'::jsonb
  ) #> '{meta,query}') ?| array['start', 'end'] then
    raise exception 'preset query retained custom dates';
  end if;

  foreach old_result in array array[
    public.get_dashboard_stats('33333333-3333-3333-3333-333333333333', 'all', null, 'UTC'),
    public.get_usage_comparison_v1('33333333-3333-3333-3333-333333333333', 'today', null, null, null, 'UTC'),
    public.get_usage_details_v1('33333333-3333-3333-3333-333333333333', 'today', null, null, null, 'UTC', null, 50)
  ] loop
    if old_result is null then raise exception 'legacy RPC signature returned null unexpectedly'; end if;
  end loop;

  foreach bad_query in array array[
    '{"range":"custom","end":"2026-03-08"}'::jsonb,
    '{"range":"custom","start":"2026-03-08"}'::jsonb,
    '{"range":"custom","start":null,"end":"2026-03-08"}'::jsonb,
    '{"range":"custom","start":20260308,"end":"2026-03-08"}'::jsonb
  ] loop
    begin perform public.get_dashboard_stats_v2('33333333-3333-3333-3333-333333333333', bad_query);
      raise exception 'dashboard accepted malformed custom bounds: %', bad_query; exception when sqlstate '22023' then null; end;
    begin perform public.get_usage_comparison_v2('33333333-3333-3333-3333-333333333333', bad_query);
      raise exception 'comparison accepted malformed custom bounds: %', bad_query; exception when sqlstate '22023' then null; end;
    begin perform public.get_usage_details_v2('33333333-3333-3333-3333-333333333333', bad_query, null, 50);
      raise exception 'details accepted malformed custom bounds: %', bad_query; exception when sqlstate '22023' then null; end;
    begin perform public.get_usage_entity_dashboard_v2(
      '33333333-3333-3333-3333-333333333333', bad_query,
      '{"kind":"model","id":"CustomModel"}'::jsonb, null, 50
    );
      raise exception 'entity accepted malformed custom bounds: %', bad_query; exception when sqlstate '22023' then null; end;
  end loop;
  begin perform public.get_dashboard_stats_v2('33333333-3333-3333-3333-333333333333', '{"range":"custom","start":"2026-02-30","end":"2026-03-08"}'::jsonb);
    raise exception 'invalid date unexpectedly succeeded'; exception when sqlstate '22023' then null; end;
  begin perform public.get_dashboard_stats_v2('33333333-3333-3333-3333-333333333333', '{"range":"custom","start":"2026-03-09","end":"2026-03-08"}'::jsonb);
    raise exception 'reversed date unexpectedly succeeded'; exception when sqlstate '22023' then null; end;
  begin perform public.get_dashboard_stats_v2('33333333-3333-3333-3333-333333333333', '{"range":"custom","start":"2024-01-01","end":"2026-01-01"}'::jsonb);
    raise exception 'range longer than 731 days unexpectedly succeeded'; exception when sqlstate '22023' then null; end;
  begin perform public.get_dashboard_stats_v2('44444444-4444-4444-4444-444444444444', q);
    raise exception 'cross-user dashboard unexpectedly succeeded'; exception when sqlstate '42501' then null; end;
end;
$$;

reset role;

set local enable_seqscan = off;
explain (analyze, buffers)
select id, timestamp
from public.token_logs
where user_id = '33333333-3333-3333-3333-333333333333'
  and timestamp >= '2026-03-08 00:00:00'
  and timestamp <= '2026-03-08 23:59:59'
order by timestamp desc, id desc
limit 50;

rollback;
