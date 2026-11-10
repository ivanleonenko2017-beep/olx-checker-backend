'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  consumeRateLimit, isAdminCommandAuthorized, splitTelegramMessages,
  formatDiagnosticMessages, formatStatusMessage
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

test('long Telegram output is split below the safe message limit', () => {
  const chunks = splitTelegramMessages(['a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000)]);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => chunk.length <= 3600));
});
