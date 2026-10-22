-- T10.273: desktop clients merge gateway ledger records with scanned logs
-- (dashboard-stats-v2 §2.5) before uploading hourly aggregates. Dedupe stays on
-- the client because the cloud only holds hourly aggregates; the aggregate
-- shape, every RPC signature and every response stay unchanged.

alter table public.token_logs
  add column if not exists gateway_requests bigint;

comment on column public.token_logs.gateway_requests is
  'Requests of this hourly aggregate that came from the desktop gateway ledger (dashboard-stats-v2 §2.5). 0 from clients that merge but saw no gateway record; null from older clients (unknown). Audit only: RPCs do not read it.';

alter table public.token_logs
  drop constraint if exists token_logs_gateway_requests_range;
alter table public.token_logs
  add constraint token_logs_gateway_requests_range
  check (gateway_requests is null or (gateway_requests >= 0 and gateway_requests <= requests))
  not valid;
alter table public.token_logs
  validate constraint token_logs_gateway_requests_range;

-- A merged upload may only delete aggregates that the gateway superseded.
-- Delete-only statements must mark the summaries dirty as well.
drop trigger if exists token_logs_sync on public.token_logs;
create trigger token_logs_sync
  after insert or update or delete on public.token_logs
  for each statement
  execute function public.sync_token_log();
