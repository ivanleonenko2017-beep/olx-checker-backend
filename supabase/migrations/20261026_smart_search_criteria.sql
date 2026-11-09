-- Smart Search criteria are optional and backward-compatible with existing filters.
-- Run in Supabase SQL Editor before deploying code that reads/writes this column.
alter table public.filters
  add column if not exists criteria jsonb not null default '{}'::jsonb;

comment on column public.filters.criteria is
  'Optional advanced search criteria for ZNAIDENO Smart Search; legacy filters use empty object.';
