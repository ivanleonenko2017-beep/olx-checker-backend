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
