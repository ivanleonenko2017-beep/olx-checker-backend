'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  consumeRateLimit, isAdminCommandAuthorized, splitTelegramMessages,
  formatDiagnosticMessages, formatStatusMessage, formatSubscriptionMessage, formatReferralMessage, maskTelegramId
} = require('./admin-command-utils');

test('admin command authorization rejects missing and ordinary users', async () => {
  assert.equal(await isAdminCommandAuthorized(null, async () => true), false);
  assert.equal(await isAdminCommandAuthorized(42, async () => false), false);
  assert.equal(await isAdminCommandAuthorized(42, async id => id === 42), true);
  assert.equal(await isAdminCommandAuthorized(42, async () => { throw new Error('db'); }), false);
});

test('admin command rate limit permits one run per minute per key', () => {
  const limits = new Map();
  assert.equal(consumeRateLimit(limits, 'admin-a', 100000), true);
  assert.equal(consumeRateLimit(limits, 'admin-a', 159999), false);
  assert.equal(consumeRateLimit(limits, 'admin-b', 159999), true);
  assert.equal(consumeRateLimit(limits, 'admin-a', 160000), true);
});

test('Telegram diagnostic formatting includes pages, funnel, cards and splits long output', () => {
  const messages = formatDiagnosticMessages({
    requestId: 'abc123',
    at: '2026-11-10T20:00:00.000Z',
    kyivTime: '2026-11-10 22:00:00',
    stopReason: 'page_limit',
    pages: [{ page: 1, httpStatus: 200, durationMs: 1200, responseBytes: 5000, cardsParsed: 30, newAfterDedup: 30 }],
    funnel: { parsed: 30, afterDedup: 30, afterCity: 5, after_model: 4, afterMemoryIncludingUnverified: 4, capacityUnverified: 1, after_condition: 4, after_price: 4, final: 4, cityUnverified: 0 },
    cards: [{ position: 1, title: '<iPhone>', price: '20 000 грн', city: 'Чернігів', modelVersion: 'Pro Max', memory: '256 GB', decision: 'прийнята' }]
  });
  assert.ok(messages.some(message => message.includes('HTTP 200')));
  assert.ok(messages.some(message => message.includes('requestId')));
  assert.ok(messages.some(message => message.includes('&lt;iPhone&gt;')));
  assert.ok(messages.join('\n').includes('Pro Max'));
  assert.ok(messages.every(message => message.length <= 3600));
});

test('diagnostic funnel formatter reports actual price-before-condition order', () => {
  const messages = formatDiagnosticMessages({
    funnel: { parsed: 10, afterDedup: 10, afterCity: 8, after_model: 7,
      afterMemoryIncludingUnverified: 6, after_excluded_words: 5,
      after_price: 4, after_condition: 3, final: 3 }
  });
  const output = messages.join('\n');
  assert.ok(output.includes('Виключення: 5'));
  assert.ok(output.includes('Ціна: 4 → стан: 3'));
  assert.ok(output.includes('рекомендацій OLX не інструментована'));
});

test('Telegram status formatting redacts bot token and never emits URL path', () => {
  const result = formatStatusMessage({
    commit: 'abc123',
    uptime: '1h 2m',
    supabaseOk: true,
    worker: { lastSuccessAt: '2026-11-10T20:00:00Z', processedFilters: 3 },
    webhook: { host: 'olx-checker-backend.onrender.com', pendingUpdates: 0, lastError: 'bad bot123456:ABCDEFsecret' },
    lastOlxStatus: 'HTTP 200'
  });
  assert.ok(result.includes('olx-checker-backend.onrender.com'));
  assert.ok(!result.includes('bot123456:ABCDEFsecret'));
  assert.ok(!result.includes('/telegram-webhook'));
});

test('admin status reports only boolean Premium bypass state', () => {
  const result = formatStatusMessage({
    supabaseOk: true,
    testPremiumBypassConfigured: true,
    testPremiumBypassEffective: false
  });
  assert.ok(result.includes('ENABLE_TEST_PREMIUM_BYPASS:</b> включён'));
  assert.ok(result.includes('фактический обход: заблокирован'));
  assert.ok(!result.includes('RENDER_SERVICE_ID'));
  assert.ok(!result.includes('TELEGRAM_BOT_TOKEN'));
});


test('subscription report masks Telegram ID, reports limits and expiry behavior', () => {
  const message = formatSubscriptionMessage({
    user: { telegram_id: 123456789, trial_started_at: '2026-11-01T00:00:00Z' },
    access: { plan: 'free', filterLimit: 1, searchLimit: 5, checkIntervalMinutes: 15 },
    filters: { total: 3, active: 1, paused: 2 },
    searchesUsed: 2,
    grantSource: 'реферальні записи є; точне джерело поточного Premium не зберігається',
    expiryBehavior: 'Free: 1 фільтр, 5 пошуків/день; зайві фільтри зберігаються, але призупинені'
  }).join('\n');
  assert.ok(message.includes('••••6789'));
  assert.ok(!message.includes('123456789'));
  assert.ok(message.includes('активні 1, призупинені лімітом 2'));
  assert.ok(message.includes('5'));
});

test('referral report masks IDs and escapes user-derived values', () => {
  const message = formatReferralMessage({
    user: { telegram_id: 123456789, referral_attributed_at: null },
    inviter: 987654321,
    invited: [111122223333],
    invitedCount: 1,
    rewardedCount: 1,
    rewardedDays: 3,
    discrepancies: ['legacy count < canonical count']
  }).join('\n');
  assert.ok(message.includes('••••6789'));
  assert.ok(message.includes('••••4321'));
  assert.ok(message.includes('&lt;'));
  assert.ok(!message.includes('123456789'));
  assert.ok(!message.includes('987654321'));
});

test('Telegram ID masking never returns a full identifier', () => {
  assert.equal(maskTelegramId('123456789'), '••••6789');
  assert.equal(maskTelegramId(''), 'не визначено');
});
test('long Telegram output is split below the safe message limit, including one oversized section', () => {
  const chunks = splitTelegramMessages(['a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000)]);
  assert.equal(chunks.length, 3);
  const diagnostic = formatDiagnosticMessages({
    requestId: 'long',
    cards: Array.from({ length: 40 }, (_, index) => ({
      position: index + 1, title: 'iPhone 15 Pro Max 256 GB ' + 'x'.repeat(90),
      price: '20 000 грн', city: 'Чернігів', modelVersion: 'Pro Max',
      memory: '256 GB', decision: 'відсів: memory_mismatch'
    }))
  });
  assert.ok(diagnostic.length > 1);
  assert.ok(diagnostic.every(chunk => chunk.length <= 3600));
  assert.ok(chunks.every(chunk => chunk.length <= 3600));
});
