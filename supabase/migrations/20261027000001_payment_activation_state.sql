alter table public.star_payments
  add column if not exists activation_status text not null default 'pending',
  add column if not exists premium_until timestamptz,
  add column if not exists is_recurring boolean not null default false,
  add column if not exists is_first_recurring boolean not null default false;

alter table public.star_payments
  drop constraint if exists star_payments_activation_status_check;
alter table public.star_payments
  add constraint star_payments_activation_status_check
  check (activation_status in ('pending', 'active', 'failed'));

comment on column public.star_payments.activation_status is
  'Idempotent payment activation state; pending rows can be safely recovered after an interrupted webhook.';
