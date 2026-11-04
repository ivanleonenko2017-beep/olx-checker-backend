const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, TRIAL_DAYS, deriveAccess, canCreateFilter } = require('./access-policy');

test('trial lasts exactly four days and then falls back to free', () => {
  const start = Date.parse('2026-10-01T12:00:00.000Z');
  const trial = deriveAccess({ tariff: 'free', trial_started_at: new Date(start).toISOString() }, false, start + 2 * DAY_MS);
  assert.equal(trial.plan, 'trial');
  assert.equal(trial.filterLimit, 3);
  assert.equal(trial.checkIntervalMinutes, 5);
  const expired = deriveAccess({ tariff: 'free', trial_started_at: new Date(start).toISOString() }, false, start + TRIAL_DAYS * DAY_MS);
  assert.equal(expired.plan, 'free');
  assert.equal(expired.filterLimit, 1);
  assert.equal(expired.searchLimit, 5);
  assert.equal(expired.checkIntervalMinutes, 15);
});

test('active paid Premium overrides an expired trial', () => {
  const access = deriveAccess({
    tariff: 'premium',
    premium_until: '2026-11-01T00:00:00.000Z',
    trial_started_at: '2026-01-01T00:00:00.000Z'
  }, false, Date.parse('2026-10-27T00:00:00.000Z'));
  assert.equal(access.plan, 'premium');
  assert.equal(access.filterLimit, 20);
  assert.equal(access.checkIntervalMinutes, 2);
});

test('expired Premium and trial return to free without deleting data', () => {
  const access = deriveAccess({
    tariff: 'premium',
    premium_until: '2026-01-01T00:00:00.000Z',
    trial_started_at: '2026-01-01T00:00:00.000Z'
  }, false, Date.parse('2026-10-27T00:00:00.000Z'));
  assert.equal(access.plan, 'free');
});

test('admin bypasses plan limits', () => {
  const access = deriveAccess({}, true);
  assert.equal(access.plan, 'admin');
  assert.equal(canCreateFilter(access, 10000), true);
});

test('filter limit is enforced per plan', () => {
  assert.equal(canCreateFilter(deriveAccess({ trial_started_at: new Date().toISOString() }), 2), true);
  assert.equal(canCreateFilter(deriveAccess({ trial_started_at: new Date().toISOString() }), 3), false);
  assert.equal(canCreateFilter(deriveAccess({}), 0), true);
  assert.equal(canCreateFilter(deriveAccess({}), 1), false);
});
