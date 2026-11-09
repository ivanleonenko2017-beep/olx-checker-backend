-- Reliability hardening: Telegram delivery state, referral attribution, and worker leases.
alter table public.users
  add column if not exists telegram_blocked_at timestamptz,
  add column if not exists pending_referrer_telegram_id bigint,
  add column if not exists referral_attributed_at timestamptz;

create table if not exists public.filter_processing_locks (
  filter_id text primary key,
  lock_owner text not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.filter_processing_locks enable row level security;
revoke all on table public.filter_processing_locks from public, anon, authenticated;
grant all on table public.filter_processing_locks to service_role;

create or replace function public.acquire_filter_processing_lock(
  p_filter_id text,
  p_lock_owner text,
  p_lease_seconds integer default 180
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acquired boolean;
  v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 180), 30), 600);
begin
  if nullif(trim(p_filter_id), '') is null or nullif(trim(p_lock_owner), '') is null then
    return false;
  end if;

  insert into public.filter_processing_locks (
    filter_id, lock_owner, locked_until, updated_at
  )
  values (
    p_filter_id, p_lock_owner, now() + make_interval(secs => v_lease_seconds), now()
  )
  on conflict (filter_id) do update
    set lock_owner = excluded.lock_owner,
        locked_until = excluded.locked_until,
        updated_at = now()
    where public.filter_processing_locks.locked_until <= now()
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.release_filter_processing_lock(
  p_filter_id text,
  p_lock_owner text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.filter_processing_locks
  where filter_id = p_filter_id
    and lock_owner = p_lock_owner;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

create or replace function public.grant_referral_reward(
  p_inviter_telegram_id bigint,
  p_invitee_telegram_id bigint
)
returns table (
  rewarded boolean,
  premium_until timestamptz,
  reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending_referrer bigint;
  v_attributed_at timestamptz;
  v_inviter_until timestamptz;
  v_next_until timestamptz;
  v_inserted_invitee bigint;
  v_user_count integer;
begin
  if p_inviter_telegram_id is null or p_invitee_telegram_id is null
     or p_inviter_telegram_id <= 0 or p_invitee_telegram_id <= 0 then
    return query select false, null::timestamptz, 'invalid_ids';
    return;
  end if;

  -- Lock both user rows in deterministic order to avoid lost Premium extensions
  -- and reduce deadlock risk when referrals are created concurrently.
  perform 1
  from public.users
  where telegram_id in (p_inviter_telegram_id, p_invitee_telegram_id)
  order by telegram_id
  for update;

  select count(*) into v_user_count
  from public.users
  where telegram_id in (p_inviter_telegram_id, p_invitee_telegram_id);

  if v_user_count < 2 then
    update public.users
    set pending_referrer_telegram_id = null,
        referral_attributed_at = coalesce(referral_attributed_at, now())
    where telegram_id = p_invitee_telegram_id
      and pending_referrer_telegram_id = p_inviter_telegram_id;
    return query select false, null::timestamptz, 'inviter_or_invitee_missing';
    return;
  end if;

  select pending_referrer_telegram_id, referral_attributed_at
    into v_pending_referrer, v_attributed_at
  from public.users
  where telegram_id = p_invitee_telegram_id;

  if v_attributed_at is not null then
    return query select false, null::timestamptz, 'already_attributed';
    return;
  end if;

  if v_pending_referrer is null then
    return query select false, null::timestamptz, 'no_pending_referral';
    return;
  end if;

  if v_pending_referrer <> p_inviter_telegram_id or p_inviter_telegram_id = p_invitee_telegram_id then
    update public.users
    set pending_referrer_telegram_id = null,
        referral_attributed_at = coalesce(referral_attributed_at, now())
    where telegram_id = p_invitee_telegram_id;
    return query select false, null::timestamptz, 'invalid_referrer';
    return;
  end if;

  select premium_until into v_inviter_until
  from public.users
  where telegram_id = p_inviter_telegram_id;

  insert into public.referrals (inviter_telegram_id, invitee_telegram_id)
  values (p_inviter_telegram_id, p_invitee_telegram_id)
  on conflict (invitee_telegram_id) do nothing
  returning invitee_telegram_id into v_inserted_invitee;

  if v_inserted_invitee is null then
    update public.users
    set pending_referrer_telegram_id = null,
        referral_attributed_at = coalesce(referral_attributed_at, now())
    where telegram_id = p_invitee_telegram_id;
    return query select false, v_inviter_until, 'already_rewarded';
    return;
  end if;

  v_next_until := greatest(coalesce(v_inviter_until, now()), now()) + interval '3 days';

  update public.users
  set tariff = 'premium',
      premium_until = v_next_until
  where telegram_id = p_inviter_telegram_id;

  update public.users
  set pending_referrer_telegram_id = null,
      referral_attributed_at = now()
  where telegram_id = p_invitee_telegram_id;

  return query select true, v_next_until, 'rewarded';
end;
$$;

revoke all on function public.acquire_filter_processing_lock(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_filter_processing_lock(text, text) from public, anon, authenticated;
revoke all on function public.grant_referral_reward(bigint, bigint) from public, anon, authenticated;
grant execute on function public.acquire_filter_processing_lock(text, text, integer) to service_role;
grant execute on function public.release_filter_processing_lock(text, text) to service_role;
grant execute on function public.grant_referral_reward(bigint, bigint) to service_role;
