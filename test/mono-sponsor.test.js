'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSponsorTelegramId, normalizeMonobankTransaction } = require('../mono-sponsor');

test('accepts only a complete positive numeric Telegram ID', () => {
  assert.equal(parseSponsorTelegramId('123456789'), 123456789);
  assert.equal(parseSponsorTelegramId(' 123456789 '), 123456789);
  assert.equal(parseSponsorTelegramId(''), null);
  assert.equal(parseSponsorTelegramId('123abc'), null);
  assert.equal(parseSponsorTelegramId('SPONSOR 123'), null);
  assert.equal(parseSponsorTelegramId('0'), null);
  assert.equal(parseSponsorTelegramId('9007199254740992'), null);
});

test('normalizes a positive Monobank transaction with an exact ID comment', () => {
  const row = normalizeMonobankTransaction({
    id: 'tx-1', time: 1760000000, amount: 2500, currencyCode: 980, comment: '123456789'
  }, 'jar-example');
  assert.deepEqual(row, {
    mono_transaction_id: 'tx-1',
    telegram_id: 123456789,
    jar_id: 'jar-example',
    amount_minor: 2500,
    currency_code: 980,
    comment: '123456789',
    occurred_at: new Date(1760000000 * 1000).toISOString()
  });
});

test('ignores outgoing, malformed, and non-matching transactions', () => {
  assert.equal(normalizeMonobankTransaction({ id: 'x', time: 1760000000, amount: -100, comment: '123' }, 'jar'), null);
  assert.equal(normalizeMonobankTransaction({ id: 'x', time: 1760000000, amount: 100, comment: 'donation 123' }, 'jar'), null);
  assert.equal(normalizeMonobankTransaction({ id: 'x', time: 1760000000, amount: 100, comment: 'not-an-id' }, 'jar'), null);
  assert.equal(normalizeMonobankTransaction({ id: 'x', amount: 100, comment: '123' }, 'jar'), null);
});
