-- SECURITY LOCKDOWN REFERENCE — applied and verified against production on 2026-10-27.
-- Project: olx-checker-db (ovblyievvseuugpbmxjy)
-- Purpose: prevent direct access via Supabase anon/authenticated API roles.
-- Production verification: RLS enabled on all nine application tables; anon/authenticated
-- have no SELECT privileges; service_role has SELECT privileges. Migration history includes
-- enable_rls_and_revoke_public_app_table_access (20261027185207).
-- This SQL is retained as a reviewable reference/recovery script; do not rerun blindly.

begin;

alter table public.users enable row level security;
alter table public.filters enable row level security;
alter table public.seen_ads enable row level security;
alter table public.payments enable row level security;
alter table public.referral_logs enable row level security;
alter table public.ad_price_history enable row level security;
alter table public.referrals enable row level security;
alter table public.star_payments enable row level security;
alter table public.user_daily_usage enable row level security;

revoke all privileges on table public.users from anon, authenticated;
revoke all privileges on table public.filters from anon, authenticated;
revoke all privileges on table public.seen_ads from anon, authenticated;
revoke all privileges on table public.payments from anon, authenticated;
revoke all privileges on table public.referral_logs from anon, authenticated;
revoke all privileges on table public.ad_price_history from anon, authenticated;
revoke all privileges on table public.referrals from anon, authenticated;
revoke all privileges on table public.star_payments from anon, authenticated;
revoke all privileges on table public.user_daily_usage from anon, authenticated;

grant all privileges on table public.users to service_role;
grant all privileges on table public.filters to service_role;
grant all privileges on table public.seen_ads to service_role;
grant all privileges on table public.payments to service_role;
grant all privileges on table public.referral_logs to service_role;
grant all privileges on table public.ad_price_history to service_role;
grant all privileges on table public.referrals to service_role;
grant all privileges on table public.star_payments to service_role;
grant all privileges on table public.user_daily_usage to service_role;

-- Existing serial/identity-backed tables. Keep these grants server-only.
revoke all privileges on all sequences in schema public from anon, authenticated;
grant usage, select, update on all sequences in schema public to service_role;

commit;

-- Verification query (run after the transaction):
-- select c.relname as table_name, c.relrowsecurity as rls_enabled
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind = 'r'
--   and c.relname in ('users','filters','seen_ads','payments','referral_logs',
--     'ad_price_history','referrals','star_payments','user_daily_usage')
-- order by c.relname;
--
-- Also run Supabase security advisors and verify:
-- 1) all nine tables have RLS enabled;
-- 2) anon/authenticated have no table privileges;
-- 3) Render /health reports serverDatabaseUsesServiceRole=true;
-- 4) /start, filters, profile, background scanning and Stars payment recovery work.
