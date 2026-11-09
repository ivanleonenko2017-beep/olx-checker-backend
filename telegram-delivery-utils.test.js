const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTelegramRetryDelaySeconds,
  isTelegramBlockedError,
  isTelegramRateLimitError
} = require('./telegram-delivery-utils');

test('uses Telegram retry_after and clamps wait to a safe bounded range', () => {
  assert.equal(getTelegramRetryDelaySeconds({ response: { data: { parameters: { retry_after: 7 } } } }), 7);
  assert.equal(getTelegramRetryDelaySeconds({ response: { data: { parameters: { retry_after: 0 } } } }), 1);
  assert.equal(getTelegramRetryDelaySeconds({ response: { data: { parameters: { retry_after: 900 } } } }), 30);
  assert.equal(getTelegramRetryDelaySeconds(new Error('network failure')), 1);
});

test('distinguishes blocked users from Telegram rate limits', () => {
  assert.equal(isTelegramBlockedError({ response: { status: 403 } }), true);
  assert.equal(isTelegramBlockedError({ response: { status: 429 } }), false);
  assert.equal(isTelegramRateLimitError({ response: { status: 429 } }), true);
});
