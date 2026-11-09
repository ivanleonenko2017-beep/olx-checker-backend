const test = require('node:test');
const assert = require('node:assert/strict');
const { safeText, sanitizeSearchUrl, hashUserId, compactRejectedCards } = require('./search-telemetry');

test('sanitizes sensitive URL query parameters and credentials', () => {
  const result = new URL(sanitizeSearchUrl('https://user:pass@www.olx.ua/search?q=iphone&token=abc&initData=secret#fragment'));
  assert.equal(result.username, '');
  assert.equal(result.password, '');
  assert.equal(result.hash, '');
  assert.equal(result.searchParams.has('token'), false);
  assert.equal(result.searchParams.has('initData'), false);
  assert.equal(result.searchParams.get('q'), 'iphone');
});

test('hashes identifiers without returning the original value', () => {
  const hash = hashUserId('123456789', 'test-secret');
  assert.match(hash, /^[a-f0-9]{12}$/);
  assert.notEqual(hash, '123456789');
  assert.equal(hashUserId('123456789', ''), null);
});

test('bounds text and per-card rejection detail', () => {
  assert.equal(safeText('a'.repeat(30), 10).length, 10);
  const result = compactRejectedCards(Array.from({ length: 30 }, (_, i) => ({
    listingKey: String(i), url: 'https://www.olx.ua/d/item-' + i, stage: 'city', reason: 'city_mismatch', value: 'Kyiv'
  })), 25);
  assert.equal(result.cards.length, 25);
  assert.equal(result.omitted, 5);
  assert.equal(result.cards[0].value, 'Kyiv');
});
