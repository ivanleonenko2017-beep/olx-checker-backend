'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTelegramRetryDelaySeconds,
  isTelegramBlockedError,
  MIN_RETRY_SECONDS,
  MAX_RETRY_SECONDS
} = require('./telegram-delivery-utils');

test('Telegram retry delay uses retry_after from API response', () => {
  assert.equal(getTelegramRetryDelaySeconds({ response: { data: { parameters: { retry_after: 7 } } } }), 7);
});

test('Telegram retry delay rounds fractional values up', () => {
  assert.equal(getTelegramRetryDelaySeconds({ response: { data: { parameters: { retry_after: 2.2 } } } }), 3);
});

test('Telegram retry delay is clamped to safe bounds', () => {
  assert.equal(getTelegramRetryDelaySeconds({ response: { data: { parameters: { retry_after: 0 } } } }), MIN_RETRY_SECONDS);
  assert.equal(getTelegramRetryDelaySeconds({ response: { data: { parameters: { retry_after: 999 } } } }), MAX_RETRY_SECONDS);
  assert.equal(getTelegramRetryDelaySeconds(new Error('network error')), MIN_RETRY_SECONDS);
});

test('only Telegram forbidden response is classified as blocked', () => {
  assert.equal(isTelegramBlockedError({ response: { status: 403 } }), true);
  assert.equal(isTelegramBlockedError({ response: { status: 429 } }), false);
  assert.equal(isTelegramBlockedError({ response: { status: 500 } }), false);
  assert.equal(isTelegramBlockedError(new Error('network error')), false);
});
