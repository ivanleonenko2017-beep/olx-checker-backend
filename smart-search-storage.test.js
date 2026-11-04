const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCriteriaToListing } = require('./smart-search');

test('storage alternatives match OLX capacities written without a space', () => {
  for (const title of [
    'Apple iPhone 11 128GB',
    'Apple iPhone 11 128 GB',
    'Apple iPhone 11 128ГБ',
    'Apple iPhone 11 128 ГБ'
  ]) {
    const result = applyCriteriaToListing(
      { title, description: '', price: 12000 },
      { anyTerms: ['128 gb', '256 gb'] }
    );
    assert.equal(result.matches, true, title);
  }
});

test('storage alternatives still reject a different capacity', () => {
  const result = applyCriteriaToListing(
    { title: 'Apple iPhone 11 64GB', description: '', price: 12000 },
    { anyTerms: ['128 gb', '256 gb'] }
  );
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'missing_any_alternative');
});

test('structured OLX condition metadata satisfies used-condition filter', () => {
  const result = applyCriteriaToListing(
    { title: 'Apple iPhone 11 128GB', description: 'Стан оголошення: вживаний.', price: 12000 },
    { anyTerms: ['128 gb', '256 gb'], condition: 'used' }
  );
  assert.equal(result.matches, true);
});

test('new-condition metadata does not satisfy used-condition filter', () => {
  const result = applyCriteriaToListing(
    { title: 'Apple iPhone 11 128GB', description: 'Стан оголошення: новий.', price: 12000 },
    { anyTerms: ['128 gb', '256 gb'], condition: 'used' }
  );
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'condition_mismatch');
});


test('unknown iPhone storage can be retained after OLX query used the requested capacity', () => {
  const { canUseUnverifiedStorageFallback } = require('./smart-search');
  const criteria = { includeTerms: ['256 ГБ'], city: 'Чернігів' };
  assert.equal(canUseUnverifiedStorageFallback({
    title: 'Apple iPhone 15',
    cardText: 'Apple iPhone 15 25 000 грн Чернігів',
    description: ''
  }, criteria), true);
});

test('unknown-storage fallback still rejects an explicitly different capacity', () => {
  const { canUseUnverifiedStorageFallback } = require('./smart-search');
  const criteria = { includeTerms: ['256 ГБ'], city: 'Чернігів' };
  assert.equal(canUseUnverifiedStorageFallback({
    title: 'Apple iPhone 15 128GB',
    cardText: 'Apple iPhone 15 128GB 25 000 грн Чернігів',
    description: ''
  }, criteria), false);
});

test('unknown-storage fallback does not bypass other criteria', () => {
  const { canUseUnverifiedStorageFallback } = require('./smart-search');
  const criteria = { includeTerms: ['256 ГБ', 'Pro Max'], city: 'Чернігів' };
  assert.equal(canUseUnverifiedStorageFallback({
    title: 'Apple iPhone 15',
    cardText: 'Apple iPhone 15 25 000 грн Чернігів',
    description: ''
  }, criteria), false);
});
