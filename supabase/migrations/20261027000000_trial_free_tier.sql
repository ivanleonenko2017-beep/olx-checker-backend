create table if not exists public.user_daily_usage (
  telegram_id bigint primary key,
  usage_date date not null default current_date,
  search_count integer not null default 0 check (search_count >= 0),
  updated_at timestamptz not null default now()
);

alter table public.user_daily_usage enable row level security;
revoke all on public.user_daily_usage from anon, authenticated;
grant all on public.user_daily_usage to service_role;

create or replace function public.consume_daily_search(p_telegram_id bigint, p_daily_limit integer)
returns table (allowed boolean, used_count integer, remaining_count integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_telegram_id is null or p_telegram_id <= 0 or p_daily_limit is null or p_daily_limit < 1 then
    return query select false, 0, 0;
    return;
  end if;

  insert into public.user_daily_usage (telegram_id, usage_date, search_count, updated_at)
  values (p_telegram_id, current_date, 1, now())
  on conflict (telegram_id) do update
    set usage_date = current_date,
        search_count = case
          when public.user_daily_usage.usage_date = current_date
            then public.user_daily_usage.search_count + 1
          else 1
        end,
        updated_at = now()
    where public.user_daily_usage.usage_date <> current_date
       or public.user_daily_usage.search_count < p_daily_limit
  returning search_count into v_count;

  if found then
    return query select true, v_count, greatest(0, p_daily_limit - v_count);
    return;
  end if;

  select u.search_count into v_count
  from public.user_daily_usage u
  where u.telegram_id = p_telegram_id and u.usage_date = current_date;

  return query select false, coalesce(v_count, p_daily_limit), 0;
end;
$$;

revoke all on function public.consume_daily_search(bigint, integer) from public, anon, authenticated;
grant execute on function public.consume_daily_search(bigint, integer) to service_role;
