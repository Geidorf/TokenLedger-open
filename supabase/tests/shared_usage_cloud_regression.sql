set ON_ERROR_STOP on

begin;
insert into auth.users (id, email) values
  ('10a00000-0000-4000-8000-000000000001', 'shared-a@example.invalid'),
  ('10a00000-0000-4000-8000-000000000002', 'shared-b@example.invalid');

do $$ begin
  if has_function_privilege('anon', 'public.sync_shared_usage_v1(text,text,jsonb,boolean)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.shared_usage_devices', 'UPDATE') then
    raise exception 'Unexpected shared usage access';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10a00000-0000-4000-8000-000000000001', true);

do $$
declare
  relay constant text := 'tl-0000000000000001';
  direct constant text := 'tl-0000000000000002';
  other_relay constant text := 'tl-0000000000000003';
  rows constant jsonb := '[{"tool":"claude","model":"example","timestamp":"2026-11-17 10:00:00","input_tokens":10,"output_tokens":2,"cached_tokens":5,"cache_write_tokens":1,"cost_usd":0,"requests":2}, {"tool":"claude","model":"example","timestamp":"2026-11-17 11:00:00","input_tokens":3,"output_tokens":1,"cached_tokens":0,"cache_write_tokens":0,"cost_usd":0,"requests":1}]';
begin
  if public.sync_shared_usage_v1('ab', relay, rows, false) <> 2
     then raise exception 'Initial relay failed'; end if;
  if public.sync_shared_usage_v1('ab', relay, rows, false) <> 0
     then raise exception 'Repeat changed identical rows'; end if;
  if public.sync_shared_usage_v1('ab', other_relay, rows, false) <> -1
     then raise exception 'Second relay was accepted'; end if;

  if (select sum(input_tokens + output_tokens) from public.token_logs where machine_id = 'peer:ab') <> 16
     then raise exception 'Unexpected effective token total'; end if;

  perform public.sync_shared_usage_v1('ab', direct, '[]', true);
  insert into public.token_logs (tool, model, input_tokens, output_tokens, timestamp, session_id, unique_key, machine_id)
  values ('claude', 'example', 15, 3, '2026-11-17 10:00:00', 'agg', 'direct-one', direct);

  if public.sync_shared_usage_v1('ab', relay, rows, false) <> 0
     then raise exception 'Late relay overwrote direct data'; end if;
  if (select count(*) from public.token_logs where timestamp = '2026-11-17 10:00:00') <> 1
     or (select count(*) from public.token_logs where machine_id = 'peer:ab') <> 1
     or (select sum(input_tokens + output_tokens) from public.token_logs) <> 22
     then raise exception 'Takeover duplicated usage or removed unrelated history'; end if;

  insert into public.token_logs (tool, model, input_tokens, output_tokens, timestamp, session_id, unique_key, machine_id)
  values ('claude', 'example', 4, 1, '2026-11-17 11:00:00', 'agg', 'direct-two', direct);
  if exists (select 1 from public.token_logs where machine_id = 'peer:ab')
     then raise exception 'Direct write did not remove matching relay row'; end if;

  perform set_config('request.jwt.claim.sub', '10a00000-0000-4000-8000-000000000002', true);
  if exists (select 1 from public.token_logs) then raise exception 'Cross-account read'; end if;
  if public.sync_shared_usage_v1('ab', other_relay, rows, false) <> 2
     then raise exception 'Relay choice leaked across accounts'; end if;
end $$;

rollback;
