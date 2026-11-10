'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  encryptTelegramUpdate, decryptTelegramUpdate,
  isValidTelegramWebhookSecret, isDuplicateWebhookUpdate
} = require('./telegram-webhook-queue');

test('webhook queue encrypts Telegram updates and decrypts only with the same secret', () => {
  const update = { update_id: 900001, message: { text: 'private user message', chat: { id: 12345 } } };
  const first = encryptTelegramUpdate(update, 'test-secret');
  const second = encryptTelegramUpdate(update, 'test-secret');
  assert.notEqual(first, second, 'fresh AES-GCM IV should produce distinct ciphertext');
  assert.equal(first.includes('private user message'), false);
  assert.deepEqual(decryptTelegramUpdate(first, 'test-secret'), update);
  assert.throws(() => decryptTelegramUpdate(first, 'different-secret'));
});

test('webhook secret validation is constant-time and rejects missing or mismatched values', () => {
  assert.equal(isValidTelegramWebhookSecret('expected-secret', 'expected-secret'), true);
  assert.equal(isValidTelegramWebhookSecret('wrong-secret', 'expected-secret'), false);
  assert.equal(isValidTelegramWebhookSecret('', ''), false);
  assert.equal(isValidTelegramWebhookSecret('short', 'longer-secret'), false);
});

test('only PostgreSQL unique violation is treated as a duplicate webhook update', () => {
  assert.equal(isDuplicateWebhookUpdate({ code: '23505' }), true);
  assert.equal(isDuplicateWebhookUpdate({ code: '42P01' }), false);
  assert.equal(isDuplicateWebhookUpdate(null), false);
});

test('webhook endpoint verifies secret before persisting and acknowledges after durable insert', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf("app.post('/telegram-webhook'");
  const end = source.indexOf('const WORKER_INSTANCE_ID', start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(route.indexOf('isValidTelegramWebhookSecret') < route.indexOf("from('telegram_webhook_updates').insert"));
  assert.ok(route.indexOf("from('telegram_webhook_updates').insert") < route.indexOf('res.sendStatus(200)'));
  assert.ok(route.indexOf('res.sendStatus(200)') < route.indexOf('setImmediate'));
  assert.match(route, /isDuplicateWebhookUpdate\(error\)/);
  assert.doesNotMatch(route, /consumeRateLimit|rateLimit/);
  assert.match(source, /\.eq\('status', 'pending'\)/);
  assert.match(source, /payload_ciphertext: ''/);
});

test('webhook queue migration is additive and inaccessible to anon/authenticated roles', () => {
  const migration = fs.readFileSync(path.join(__dirname, 'supabase/migrations/20261110235000_telegram_webhook_updates.sql'), 'utf8');
  assert.match(migration, /create table public\.telegram_webhook_updates/i);
  assert.match(migration, /update_id bigint primary key/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.telegram_webhook_updates from public, anon, authenticated/i);
  assert.match(migration, /grant all on table public\.telegram_webhook_updates to service_role/i);
  assert.doesNotMatch(migration, /drop table|truncate|delete from|alter table .* drop/i);
});
