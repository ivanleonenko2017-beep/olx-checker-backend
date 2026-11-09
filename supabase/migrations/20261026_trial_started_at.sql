-- OLX Checker: one-time 5-day trial from first Mini App launch.
-- Run in Supabase SQL Editor before deploying the application changes.
alter table public.users
  add column if not exists trial_started_at timestamptz;

-- Start the trial lazily on the first authenticated Mini App profile request.
-- Existing users will start when they next open the app; admins and paid Premium remain unaffected.
