'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveAccess } = require('./access-policy');
const {
  consumeRateLimit, isAdminCommandAuthorized, splitTelegramMessages,
  formatDiagnosticMessages, formatStatusMessage, formatSubscriptionMessage, formatReferralMessage, maskTelegramId, translateTelegramWebhookError
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
  assert.ok(result.includes('ENABLE_TEST_PREMIUM_BYPASS:</b> увімкнено'));
  assert.ok(result.includes('фактичний обхід: заблоковано'));
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
  assert.ok(message.includes('Premium початок:'));
  assert.ok(message.includes('не зберігається окремо в users'));
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
    legacyInvited: [222233334444],
    legacyInvitedCount: 1,
    rewardedCount: 1,
    rewardedDays: 3,
    discrepancies: ['legacy count < canonical count']
  }).join('\n');
  assert.ok(message.includes('••••6789'));
  assert.ok(message.includes('••••4321'));
  assert.ok(message.includes('&lt;'));
  assert.ok(message.includes('Legacy referral_logs:</b> 1'));
  assert.ok(message.includes('legacy 1. ••••4444'));
  assert.ok(!message.includes('123456789'));
  assert.ok(!message.includes('987654321'));
});

test('Telegram ID masking never returns a full identifier', () => {
  assert.equal(maskTelegramId('123456789'), '••••6789');
  assert.equal(maskTelegramId(''), 'не визначено');
});

test('trial expires after four days and Free limits apply without deleting filters', () => {
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const trial = deriveAccess({ tariff: 'free', trial_started_at: new Date(start).toISOString() }, false, start + 4 * 86400000 - 1);
  const free = deriveAccess({ tariff: 'free', trial_started_at: new Date(start).toISOString() }, false, start + 4 * 86400000);
  assert.equal(trial.plan, 'trial');
  assert.equal(trial.filterLimit, 3);
  assert.equal(trial.searchLimit, 30);
  assert.equal(free.plan, 'free');
  assert.equal(free.filterLimit, 1);
  assert.equal(free.searchLimit, 5);
  assert.equal(free.checkIntervalMinutes, 15);
});

test('expired Premium falls back to Free using the supplied mock clock', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const access = deriveAccess({
    tariff: 'premium',
    premium_until: new Date(now - 1).toISOString(),
    trial_started_at: new Date(now - 10 * 86400000).toISOString()
  }, false, now);
  assert.equal(access.plan, 'free');
  assert.equal(access.filterLimit, 1);
  assert.equal(access.searchLimit, 5);
});

test('sub and ref are behind the same server-side admin gate and read-only branch', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const matcher = source.match(/const adminCommandMatch = text\.match\(([^;]+);/);
  assert.ok(matcher && matcher[1].includes('diag|status|sub|ref'));
  const gate = source.indexOf('if (!(await isAdminCommandAuthorized(senderId, checkIsAdmin)))');
  const branch = source.indexOf("if (command === 'sub' || command === 'ref')");
  const nextCommand = source.indexOf("if (command === 'diag')", branch);
  assert.ok(gate >= 0 && branch > gate && nextCommand > branch);
  const accountBranch = source.slice(branch, nextCommand);
  assert.doesNotMatch(accountBranch, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
});

test('worker applies Free filter cap by pausing excess rows instead of deleting them', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const workerStart = source.indexOf('async function runBackgroundWorker()');
  const workerEnd = source.indexOf('const ENABLE_BACKGROUND_WORKER', workerStart);
  const worker = source.slice(workerStart, workerEnd);
  assert.match(worker, /processedCount >= filterLimit/);
  assert.match(worker, /filterLimit =/);
  assert.doesNotMatch(worker, /from\('filters'\)\.delete\(/);
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


test('admin statistics route is protected and exposes only aggregate read counts', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf("app.get('/api/admin/stats', adminAuthMiddleware");
  const end = source.indexOf("app.get('/api/admin/diagnostics'", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /from\('users'\)\.select\('telegram_id', \{ count: 'exact', head: true \}\)/);
  assert.match(route, /from\('filters'\)\.select\('id', \{ count: 'exact', head: true \}\)/);
  assert.match(route, /from\('seen_ads'\)\.select\('id', \{ count: 'exact', head: true \}\)/);
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  assert.match(route, /res\.status\(503\)/);
});


test('diagnostic formatter displays load, parse, detail-enrichment and peak RSS metrics', () => {
  const output = formatDiagnosticMessages({
    pages: [{ page: 1, httpStatus: 200, durationMs: 1000, loadDurationMs: 300,
      parseDurationMs: 700, memoryRssBytes: 64 * 1024 * 1024, responseBytes: 1000 }],
    performance: { loadMs: 300, parseMs: 700, detailsEnrichmentMs: 250, totalMs: 1400, peakRssBytes: 64 * 1024 * 1024 }
  }).join('\n');
  assert.ok(output.includes('Завантаження: 300 мс'));
  assert.ok(output.includes('розбір: 700 мс'));
  assert.ok(output.includes('догрузка деталей: 250 мс'));
  assert.ok(output.includes('Пік RSS: 64 МБ'));
});


test('admin status labels are Ukrainian and webhook error timestamp is formatted in Kyiv time', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /timeZone: 'Europe\/Kyiv'/);
  const utils = fs.readFileSync(path.join(__dirname, 'admin-command-utils.js'), 'utf8');
  assert.match(utils, /Час роботи/);
  assert.match(utils, /домен=/);
  assert.match(utils, /очікують=/);
  assert.doesNotMatch(utils, /фактический обход|включён|выключен|не определён|не удалось получить/);
});

test('Telegram update processor is decoupled from the Express response lifecycle', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf('async function processTelegramUpdate(update)');
  const end = source.indexOf('const telegramWebhookInFlight', start);
  const processor = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(processor, /\bres\./);
  assert.match(processor, /throw err/);
});


test('Telegram webhook errors are presented in Ukrainian without raw English provider text', () => {
  assert.equal(translateTelegramWebhookError('Wrong response from the webhook: 429 Too Many Requests'),
    'Webhook відповів HTTP 429: забагато запитів.');
  assert.equal(translateTelegramWebhookError('Wrong response from the webhook: 401 Unauthorized'),
    'Webhook відхилив запит (HTTP 401): перевірку секрету не пройдено.');
  assert.equal(translateTelegramWebhookError('502 Bad Gateway'),
    'Webhook повернув HTTP 502: помилка шлюзу.');
  assert.equal(translateTelegramWebhookError('some provider failure'),
    'Telegram повідомив про помилку webhook.');
});

test('Mini App and admin status contain no known Russian UI phrases', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, 'admin-command-utils.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const russianUi = /ошибка|ошибк[аиуы]?|включён|выключен|не определён|не удалось|пользователь|объявлени[еяй]?|введите|попробуйте|укажите|выберите|платеж[аеи]?|сейчас|позже/iu;
  assert.doesNotMatch(html, russianUi);
  assert.doesNotMatch(admin, russianUi);
  assert.doesNotMatch(server, /Ошибка проверки initData|HTTP статус не определён|не удалось получить getWebhookInfo|не определён/iu);
});
