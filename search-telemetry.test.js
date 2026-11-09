const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { safeText, sanitizeSearchUrl, hashUserId, compactRejectedCards, evaluateCriteriaFunnel, summarizeCriteria } = require('./search-telemetry');

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

test('reports model, memory, condition and price funnel without weakening criteria', () => {
  const listings = [
    { title: 'Apple iPhone 15 256 GB', price: 20000, cardText: 'Чернігів • Б/у' },
    { title: 'Apple iPhone 15 Pro 256 GB', price: 20000, cardText: 'Чернігів • Б/у' },
    { title: 'Apple iPhone 15', price: 20000, cardText: 'Чернігів • Б/у' },
    { title: 'Apple iPhone 15 256 GB', price: 9000, cardText: 'Чернігів • Новий' }
  ];
  const result = evaluateCriteriaFunnel(listings, {
    modelTerm: 'iPhone 15', includeTerms: ['256 GB'], includeTermsMode: 'all',
    minPrice: 15000, maxPrice: 30000, condition: 'used'
  });
  assert.equal(result.counts.after_model, 3);
  assert.equal(result.capacityUnverified, 1);
  assert.equal(result.counts.after_price, 2);
  assert.equal(result.counts.after_condition, 2);
  assert.equal(result.finalCount, 2);
});

test('redacts free-text query from OLX search path and emits only normalized criteria', () => {
  const safeUrl = sanitizeSearchUrl('https://www.olx.ua/uk/chernigov/q-private-phone-number-123456/');
  assert.match(safeUrl, /q-REDACTED/);
  assert.doesNotMatch(safeUrl, /123456/);
  const summary = summarizeCriteria({
    modelTerm: 'iPhone 15', includeTerms: ['256 GB', 'private phone 123456'],
    anyTerms: [], excludeTerms: ['icloud'], condition: 'used', city: 'Чернігів'
  });
  assert.equal(summary.model, 'iPhone 15');
  assert.deepEqual(summary.memoryGb, ['256']);
  assert.equal(summary.includeTermCount, 2);
  assert.equal(JSON.stringify(summary).includes('123456'), false);
});

test('admin diagnostic route is wired through server-side admin authentication', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /app\.post\(['"]\/api\/admin\/search-diagnostics['"],\s*adminAuthMiddleware/);
});
