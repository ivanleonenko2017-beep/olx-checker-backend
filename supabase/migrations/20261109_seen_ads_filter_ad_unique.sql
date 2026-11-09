-- Prevent duplicate notification baselines for the same filter/listing pair.
-- Abort safely instead of deleting or rewriting existing rows if historical duplicates exist.
do $$
begin
  if exists (
    select 1
    from public.seen_ads
    group by filter_id, ad_link
    having count(*) > 1
  ) then
    raise exception 'seen_ads contains duplicate (filter_id, ad_link) pairs; reconcile them before applying this migration';
  end if;
end
$$;

create unique index if not exists seen_ads_filter_ad_link_unique
  on public.seen_ads (filter_id, ad_link);
