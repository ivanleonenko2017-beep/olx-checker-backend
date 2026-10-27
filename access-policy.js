const DAY_MS = 24 * 60 * 60 * 1000;

const TRIAL_DAYS = 4;
const TRIAL_FILTER_LIMIT = 3;
const FREE_FILTER_LIMIT = 1;
const PREMIUM_FILTER_LIMIT = 20;
const TRIAL_SEARCH_LIMIT = 30;
const FREE_SEARCH_LIMIT = 5;
const PREMIUM_SEARCH_LIMIT = 100;
const TRIAL_CHECK_INTERVAL_MINUTES = 5;
const FREE_CHECK_INTERVAL_MINUTES = 15;
const PREMIUM_CHECK_INTERVAL_MINUTES = 2;
const PREMIUM_PRICE_UAH = 149;

function deriveAccess(user = {}, isAdmin = false, now = Date.now()) {
  const premiumUntil = user.premium_until ? Date.parse(user.premium_until) : 0;
  const hasActivePremium = Boolean(
    isAdmin ||
    (user.tariff === 'premium' && Number.isFinite(premiumUntil) && premiumUntil > now)
  );
  const trialStart = user.trial_started_at ? Date.parse(user.trial_started_at) : 0;
  const trialEndsMs = Number.isFinite(trialStart) && trialStart > 0 ? trialStart + TRIAL_DAYS * DAY_MS : 0;
  const hasActiveTrial = !hasActivePremium && trialEndsMs > now;
  const plan = isAdmin ? 'admin' : hasActivePremium ? 'premium' : hasActiveTrial ? 'trial' : 'free';

  return {
    plan,
    hasActivePremium,
    hasActiveTrial,
    trialEndsAt: trialEndsMs > 0 ? new Date(trialEndsMs).toISOString() : null,
    filterLimit: plan === 'admin' ? Infinity : plan === 'premium' ? PREMIUM_FILTER_LIMIT :
      plan === 'trial' ? TRIAL_FILTER_LIMIT : FREE_FILTER_LIMIT,
    searchLimit: plan === 'admin' ? Infinity : plan === 'premium' ? PREMIUM_SEARCH_LIMIT :
      plan === 'trial' ? TRIAL_SEARCH_LIMIT : FREE_SEARCH_LIMIT,
    checkIntervalMinutes: plan === 'admin' || plan === 'premium' ? PREMIUM_CHECK_INTERVAL_MINUTES :
      plan === 'trial' ? TRIAL_CHECK_INTERVAL_MINUTES : FREE_CHECK_INTERVAL_MINUTES,
    premiumPriceUah: PREMIUM_PRICE_UAH
  };
}

function canCreateFilter(access, currentFilterCount) {
  return access.plan === 'admin' || Number(currentFilterCount || 0) < access.filterLimit;
}

module.exports = {
  DAY_MS,
  TRIAL_DAYS,
  TRIAL_FILTER_LIMIT,
  FREE_FILTER_LIMIT,
  PREMIUM_FILTER_LIMIT,
  TRIAL_SEARCH_LIMIT,
  FREE_SEARCH_LIMIT,
  PREMIUM_SEARCH_LIMIT,
  TRIAL_CHECK_INTERVAL_MINUTES,
  FREE_CHECK_INTERVAL_MINUTES,
  PREMIUM_CHECK_INTERVAL_MINUTES,
  PREMIUM_PRICE_UAH,
  deriveAccess,
  canCreateFilter
};
