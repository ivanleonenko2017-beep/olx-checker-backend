-- Required for per-filter polling intervals in OLX Checker 1.0.0.
alter table public.filters
  add column if not exists last_checked_at timestamptz;

create index if not exists filters_last_checked_at_idx
  on public.filters (last_checked_at);
