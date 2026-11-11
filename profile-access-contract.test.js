'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DAY_MS, TRIAL_DAYS, deriveAccess } = require('./access-policy');

function profileAccess(user, isAdmin, now) {
  const access = deriveAccess(user, isAdmin, now);
  return {
    plan: access.plan,
    filterLimit: Number.isFinite(access.filterLimit) ? access.filterLimit : null,
    searchLimit: Number.isFinite(access.searchLimit) ? access.searchLimit : null,
    checkIntervalMinutes: access.checkIntervalMinutes
  };
}

test('profile access contract returns the exact Free limits', () => {
  assert.deepEqual(profileAccess({ tariff: 'free' }, false, Date.parse('2026-11-11T00:00:00Z')), {
    plan: 'free', filterLimit: 1, searchLimit: 5, checkIntervalMinutes: 15
  });
});

test('profile access contract returns the exact active Trial limits', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  const started = new Date(now - DAY_MS).toISOString();
  assert.deepEqual(profileAccess({ tariff: 'free', trial_started_at: started }, false, now), {
    plan: 'trial', filterLimit: 3, searchLimit: 30, checkIntervalMinutes: 5
  });
});

test('profile access contract returns the exact active Premium limits', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  assert.deepEqual(profileAccess({
    tariff: 'premium', premium_until: new Date(now + DAY_MS).toISOString()
  }, false, now), {
    plan: 'premium', filterLimit: 20, searchLimit: 100, checkIntervalMinutes: 2
  });
});

test('expired Premium profile falls back to Free limits', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  assert.deepEqual(profileAccess({
    tariff: 'premium', premium_until: new Date(now - 1).toISOString()
  }, false, now), {
    plan: 'free', filterLimit: 1, searchLimit: 5, checkIntervalMinutes: 15
  });
});

test('administrator profile returns null for infinite limits and is explicitly labelled in Mini App', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  assert.deepEqual(profileAccess({}, true, now), {
    plan: 'admin', filterLimit: null, searchLimit: null, checkIntervalMinutes: 2
  });
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf("app.get('/api/user/profile', userAuthMiddleware");
  const end = source.indexOf("app.get('/api/user/filters'", start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /deriveAccess\(userData, isAdmin\)/);
  assert.match(route, /filterLimit: Number\.isFinite\(access\.filterLimit\) \? access\.filterLimit : null/);
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /isAdminUser \? 'Адмін · без ліміту'/);
});

test('profile endpoint remains authenticated and no tariff limit is widened', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /app\.get\('\/api\/user\/profile', userAuthMiddleware/);
  assert.match(source, /filterLimit: access\.filterLimit/);
});
