'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNaturalLanguageQuery,
  applyCriteriaToListing,
  canUseUnverifiedStorageFallback,
  getPhoneModelLabel,
  isAccessoryIntent,
  isNonPhoneOfferTitle
} = require('./smart-search');
const { evaluateCriteriaFunnel, summarizeCriteria } = require('./search-telemetry');

test('D1: iPhone 14 Chernihiv defaults to all available versions', () => {
  const parsed = parseNaturalLanguageQuery('iPhone 14 Чернігів');
  assert.equal(parsed.criteria.modelTerm, 'iPhone 14');
  assert.equal(parsed.criteria.modelScope, 'all');
  assert.equal(parsed.criteria.city, 'Чернігів');
  const titles = [
    'Айфон 14 на 128gb',
    'iPhone 14 Plus 128GB',
    'iPhone 14 Pro 128GB',
    'iPhone 14 Pro Max 128GB'
  ];
  assert.deepEqual(titles.map(title => applyCriteriaToListing({ title, price: 18000 }, { ...parsed.criteria, city: '' }).matches),
    [true, true, true, true]);
});

test('D2: explicit Pro Max stays exact, including joined spelling', () => {
  const parsed = parseNaturalLanguageQuery('iPhone14ProMax');
  assert.equal(parsed.criteria.modelScope, 'pro max');
  assert.equal(applyCriteriaToListing({ title: 'iPhone 14 Pro Max 256GB', price: 18000 }, parsed.criteria).matches, true);
  for (const title of ['iPhone 14 Pro 256GB', 'iPhone 14 Plus 256GB', 'iPhone 14 256GB']) {
    assert.equal(applyCriteriaToListing({ title, price: 18000 }, parsed.criteria).reason, 'model_mismatch');
  }
});

test('D3: explicit negative Pro wording selects only the base iPhone', () => {
  const parsed = parseNaturalLanguageQuery('айфон 14 без про');
  assert.equal(parsed.criteria.modelScope, 'base');
  assert.equal(applyCriteriaToListing({ title: 'iPhone 14 128GB', price: 15000 }, parsed.criteria).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'iPhone 14 Pro 128GB', price: 15000 }, parsed.criteria).reason, 'model_mismatch');
});

test('D4: accessory intent searches accessories and does not inherit iPhone model scope', () => {
  const query = 'чохол на айфон 14';
  const parsed = parseNaturalLanguageQuery(query);
  assert.equal(isAccessoryIntent(query), true);
  assert.equal(parsed.criteria.modelTerm || '', '');
  assert.equal(isNonPhoneOfferTitle('Чохол на iPhone 14 Pro Max'), true);
});

test('D5: phone titles mentioning included accessories remain phones', () => {
  assert.equal(isNonPhoneOfferTitle('iPhone 14 Pro 128, чохол у подарунок'), false);
  assert.equal(isNonPhoneOfferTitle('iPhone 14, з зарядкою, коробка'), false);
  assert.equal(isNonPhoneOfferTitle('куплю айфон 14'), true);
});

test('D6: /diag fixture 42e765075099 retains five Chernihiv family phones, one memory-unverified', () => {
  const fixture = {
    requestId: '42e765075099',
    query: 'куплю айфон 15 на 256 в чернигове',
    listings: [
      { title: 'Iphone 15 pro 256 Gb фіз сім Natural Titanium', price: 29500 },
      { title: 'Айфон 15 про макс 256гб 100%', price: 17000 },
      { title: 'Телефон Iphone 15 Pro Max Apple Айфон', price: 30500 },
      { title: 'Продам iPhone 15 PRO MAX / 256 gb', price: 28500 },
      { title: 'Продам IPhone 15 Pro Max 256 GB', price: 32000 }
    ]
  };
  const parsed = parseNaturalLanguageQuery(fixture.query);
  assert.equal(parsed.criteria.modelScope, 'all');
  const criteria = { ...parsed.criteria, city: '' }; // city was already strictly matched by the /diag city stage
  const accepted = [];
  for (const listing of fixture.listings) {
    const result = applyCriteriaToListing(listing, criteria);
    if (result.matches) accepted.push(listing);
    else if (result.reason === 'missing_required_term' && canUseUnverifiedStorageFallback(listing, criteria)) {
      accepted.push({ ...listing, capacityUnverified: true });
    }
  }
  assert.equal(accepted.length, 5, fixture.requestId);
  assert.equal(accepted.filter(item => !item.capacityUnverified).length, 4);
  assert.equal(accepted.filter(item => item.capacityUnverified).length, 1);
  assert.deepEqual([...new Set(accepted.map(item => getPhoneModelLabel(item.title, 15)))].sort(), ['Pro', 'Pro Max']);
});

test('D7: diagnostics preserve model scope and label accessory rejection stage', () => {
  const summary = summarizeCriteria({ modelTerm: 'iPhone 14', modelScope: 'all', includeTerms: ['256 ГБ'] });
  assert.equal(summary.modelScope, 'all');
  const result = evaluateCriteriaFunnel([
    { title: 'Чохол на iPhone 14', price: 200 },
    { title: 'iPhone 14 Pro 256GB', price: 20000 }
  ], { modelTerm: 'iPhone 14', modelScope: 'all' });
  assert.equal(result.rejected[0].stage, 'accessory');
  assert.equal(result.rejected[0].reason, 'accessory');
});

test('D8: server diagnostics expose the smartphone category and version counts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /mobile_phones/);
  assert.match(source, /accessoryIntent/);
  assert.match(source, /versionCounts/);
  assert.match(source, /accessoriesExcluded/);
  assert.match(source, /mobilnye-telefony-smartfony/);
});
