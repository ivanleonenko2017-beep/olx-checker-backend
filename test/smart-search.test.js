const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNaturalLanguageQuery,
  applyCriteriaToListing
} = require('../smart-search');

test('natural language iPhone capacity query extracts city and storage requirement', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове');
  assert.equal(parsed.query, 'айфон 15');
  assert.equal(parsed.criteria.city, 'Чернігів');
  assert.deepEqual(parsed.criteria.includeTerms, ['256 ГБ']);
});

test('iPhone capacity matches when it is present in the listing title', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове');
  const result = applyCriteriaToListing({
    title: 'Apple iPhone 15 256GB',
    cardText: 'Apple iPhone 15 256GB 25 000 грн Чернігів',
    description: ''
  }, parsed.criteria);
  assert.equal(result.matches, true);
});

test('iPhone capacity matches when it is present in enriched listing specifications', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове');
  const result = applyCriteriaToListing({
    title: 'Apple iPhone 15',
    cardText: 'Apple iPhone 15 25 000 грн Чернігів',
    description: 'Вбудована пам’ять: 256 ГБ'
  }, parsed.criteria);
  assert.equal(result.matches, true);
});

test('iPhone capacity does not match a different storage size', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове');
  const result = applyCriteriaToListing({
    title: 'Apple iPhone 15',
    cardText: 'Apple iPhone 15 25 000 грн',
    description: 'Вбудована пам’ять: 128 ГБ'
  }, parsed.criteria);
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'missing_required_term');
});

test('iPhone storage requirement does not match a bare memory number in MB', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове');
  const result = applyCriteriaToListing({
    title: 'Apple iPhone 15',
    cardText: 'Apple iPhone 15 25 000 грн',
    description: '256 МБ RAM'
  }, parsed.criteria);
  assert.equal(result.matches, false);
});
