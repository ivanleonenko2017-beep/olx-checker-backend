-- Durable, encrypted Telegram webhook queue.
-- The application clears payload_ciphertext after successful processing; only update_id remains for deduplication.
create table public.telegram_webhook_updates (
  update_id bigint primary key,
  payload_ciphertext text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processed')),
  attempts integer not null default 0
    check (attempts >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index telegram_webhook_updates_pending_created_idx
  on public.telegram_webhook_updates (created_at)
  where status = 'pending';

alter table public.telegram_webhook_updates enable row level security;
revoke all on table public.telegram_webhook_updates from public, anon, authenticated;
grant all on table public.telegram_webhook_updates to service_role;
