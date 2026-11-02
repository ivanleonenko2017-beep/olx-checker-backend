const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNaturalLanguageQuery, applyCriteriaToListing } = require('./smart-search');

test('strips purchase intent and treats normal battery as a soft defect exclusion', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 14 с норм батарея');
  assert.equal(parsed.query, 'айфон 14');
  assert.ok(parsed.criteria.excludeTerms.includes('несправна батарея'));
  assert.equal(parsed.criteria.includeTerms.length, 0);

  const healthyOrUnspecified = applyCriteriaToListing({
    title: 'Apple iPhone 14 128GB',
    description: 'Гарний стан, все працює'
  }, parsed.criteria);
  assert.equal(healthyOrUnspecified.matches, true);

  const defective = applyCriteriaToListing({
    title: 'Apple iPhone 14',
    description: 'Батарея не тримає заряд'
  }, parsed.criteria);
  assert.equal(defective.matches, false);
  assert.equal(defective.reason, 'excluded_term');
});

test('extracts explicit phone storage capacity from the OLX free-text query', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 14 256гб');
  assert.equal(parsed.query, 'айфон 14');
  assert.ok(parsed.criteria.includeTerms.includes('256 ГБ'));

  assert.equal(applyCriteriaToListing({
    title: 'Apple iPhone 14 256GB',
    description: ''
  }, parsed.criteria).matches, true);

  assert.equal(applyCriteriaToListing({
    title: 'Apple iPhone 14 128 GB',
    description: ''
  }, parsed.criteria).matches, false);
});

test('matches used condition from OLX card metadata, not only title/description', () => {
  const criteria = { condition: 'used' };
  const result = applyCriteriaToListing({
    title: 'Apple iPhone 14 128GB',
    description: 'У хорошому стані',
    cardText: 'Apple iPhone 14 128GB 12 000 грн Стан: Вживане'
  }, criteria);
  assert.equal(result.matches, true);
});

test('does not treat an explicitly new item as used', () => {
  const result = applyCriteriaToListing({
    title: 'Apple iPhone 14 128GB',
    description: 'Новий, запакований',
    cardText: 'Стан: Нове'
  }, { condition: 'used' });
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'condition_mismatch');
});
