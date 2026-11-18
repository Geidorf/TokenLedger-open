-- Keep remote usage in the existing dashboard ledger, with one relay per
-- source computer. A direct uploader takes precedence in matching buckets.
create table public.shared_usage_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null check (source_id ~ '^[0-9a-f]{1,64}$'),
  relay_device text,
  direct_device text,
  primary key (user_id, source_id),
  unique (user_id, direct_device)
);
alter table public.shared_usage_devices enable row level security;
revoke all on public.shared_usage_devices from public, anon, authenticated;

create function public.sync_shared_usage_v1(
  p_source text, p_device text, p_rows jsonb, p_direct boolean
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_device public.shared_usage_devices%rowtype;
  v_changed integer := 0;
  v_count integer;
begin
  if v_user is null or p_source is null or p_source !~ '^[0-9a-f]{1,64}$'
     or p_device is null or p_device !~ '^tl-[0-9a-f]{16}$'
     or p_direct is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) > 500 then
    raise exception 'Invalid shared usage input';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('shared-usage:' || v_user::text, 0));
  insert into public.shared_usage_devices (user_id, source_id, relay_device, direct_device)
    values (v_user, p_source, case when not p_direct then p_device end,
            case when p_direct then p_device end)
    on conflict (user_id, source_id) do nothing;
  select * into strict v_device from public.shared_usage_devices
    where user_id = v_user and source_id = p_source;

  if p_direct then
    if v_device.direct_device is not null and v_device.direct_device <> p_device then
      raise exception 'Source already belongs to another direct device';
    end if;
    update public.shared_usage_devices set direct_device = p_device
      where user_id = v_user and source_id = p_source and direct_device is null;
    delete from public.token_logs as proxy
      using public.token_logs as direct
      where proxy.user_id = v_user and proxy.machine_id = 'peer:' || p_source
        and direct.user_id = v_user and direct.machine_id = p_device
        and (direct.timestamp, direct.tool, direct.model) = (proxy.timestamp, proxy.tool, proxy.model);
    get diagnostics v_changed = row_count;
    return v_changed;
  end if;

  if v_device.relay_device is null then
    update public.shared_usage_devices set relay_device = p_device
      where user_id = v_user and source_id = p_source;
  elsif v_device.relay_device <> p_device then
    return -1;
  end if;

  if exists (select 1 from jsonb_to_recordset(p_rows) as r(
      tool text, model text, timestamp text, input_tokens bigint, output_tokens bigint,
      cached_tokens bigint, cache_write_tokens bigint, cost_usd double precision, requests bigint)
    where r.tool is null or r.model is null or r.timestamp is null
      or r.timestamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:00:00$'
      or r.input_tokens is null or r.input_tokens < 0 or r.output_tokens is null or r.output_tokens < 0
      or r.cached_tokens is null or r.cached_tokens < 0 or r.cache_write_tokens is null
      or r.cache_write_tokens < 0 or r.cache_write_tokens > r.cached_tokens
      or r.requests is null or r.requests < 1 or r.cost_usd is null
      or r.cost_usd < 0 or r.cost_usd >= 'Infinity'::double precision) then
    raise exception 'Invalid shared usage aggregate';
  end if;

  insert into public.token_logs as stored (
      user_id, tool, model, timestamp, input_tokens, output_tokens, cached_tokens,
      cache_write_tokens, cost_usd, requests, gateway_requests, machine_id, session_id, unique_key)
    select v_user, r.tool, r.model, r.timestamp, r.input_tokens, r.output_tokens, r.cached_tokens,
      r.cache_write_tokens, r.cost_usd, r.requests, r.requests, 'peer:' || p_source, 'agg',
      'shared_' || pg_catalog.md5(jsonb_build_array(p_source, r.tool, r.model, r.timestamp)::text)
    from jsonb_to_recordset(p_rows) as r(tool text, model text, timestamp text, input_tokens bigint,
      output_tokens bigint, cached_tokens bigint, cache_write_tokens bigint, cost_usd double precision, requests bigint)
    where not exists (select 1 from public.token_logs as direct
      where direct.user_id = v_user and direct.machine_id = v_device.direct_device
        and (direct.timestamp, direct.tool, direct.model) = (r.timestamp, r.tool, r.model))
    on conflict (user_id, unique_key) do update set input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens,
      cache_write_tokens = excluded.cache_write_tokens, cost_usd = excluded.cost_usd,
      requests = excluded.requests, gateway_requests = excluded.gateway_requests
    where (stored.input_tokens, stored.output_tokens, stored.cached_tokens, stored.cache_write_tokens,
           stored.cost_usd, stored.requests) is distinct from
          (excluded.input_tokens, excluded.output_tokens, excluded.cached_tokens, excluded.cache_write_tokens,
           excluded.cost_usd, excluded.requests);
  get diagnostics v_count = row_count;
  return v_changed + v_count;
end;
$$;
revoke all on function public.sync_shared_usage_v1(text, text, jsonb, boolean) from public, anon;
grant execute on function public.sync_shared_usage_v1(text, text, jsonb, boolean) to authenticated;

create function public.prefer_direct_usage_v1() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_source text;
begin
  if new.user_id is distinct from auth.uid() or new.machine_id !~ '^tl-[0-9a-f]{16}$' then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('shared-usage:' || new.user_id::text, 0));
  select source_id into v_source from public.shared_usage_devices
    where user_id = new.user_id and direct_device = new.machine_id;
  if found then
    delete from public.token_logs
      where user_id = new.user_id and machine_id = 'peer:' || v_source
        and (timestamp, tool, model) = (new.timestamp, new.tool, new.model);
  end if;
  return new;
end;
$$;
revoke all on function public.prefer_direct_usage_v1() from public, anon, authenticated;
create trigger prefer_direct_usage_v1 before insert on public.token_logs
for each row execute function public.prefer_direct_usage_v1();
