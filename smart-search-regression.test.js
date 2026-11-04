const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNaturalLanguageQuery, applyCriteriaToListing } = require('./smart-search');

test('strips purchase intent and treats normal battery as a soft defect exclusion', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 14 с норм батарея');
  assert.equal(parsed.query, 'iPhone 14');
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
  assert.equal(parsed.query, 'iPhone 14');
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


test('parses iPhone 11 budget and normal-screen preference', () => {
  const parsed = parseNaturalLanguageQuery('ищу айфон 11 до 10к с норм экраном');
  assert.equal(parsed.query, 'iPhone 11');
  assert.equal(parsed.criteria.maxPrice, 10000);
  assert.ok(parsed.criteria.excludeTerms.some(term => /розбитий екран/.test(term)));
  assert.equal(applyCriteriaToListing({ title: 'Apple iPhone 11 64GB', price: 8500, description: 'Працює, гарний стан' }, parsed.criteria).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'Apple iPhone 11', price: 8500, description: 'Розбитий екран' }, parsed.criteria).matches, false);
});

test('parses AirPods 2 and soft good-condition preference', () => {
  const parsed = parseNaturalLanguageQuery('ищу аирподсы 2 в норм состоянии');
  assert.equal(parsed.query, 'AirPods 2');
  assert.ok(parsed.criteria.excludeTerms.includes('потребує ремонту'));
  assert.equal(applyCriteriaToListing({ title: 'Apple AirPods 2', price: 1200, description: 'Все працює' }, parsed.criteria).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'Apple AirPods 2', price: 800, description: 'Не працює правий навушник' }, parsed.criteria).matches, false);
});

test('parses Samsung Galaxy 4 and normal battery as soft preference', () => {
  const parsed = parseNaturalLanguageQuery('ищу самсунг гелекси 4 с норм батареей');
  assert.equal(parsed.query, 'Samsung Galaxy 4');
  assert.ok(parsed.criteria.excludeTerms.includes('не держит заряд'));
  assert.equal(applyCriteriaToListing({ title: 'Samsung Galaxy Watch 4', price: 2500, description: 'Стан хороший' }, parsed.criteria).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'Samsung Galaxy Watch 4', price: 1500, description: 'Батарея не держит заряд' }, parsed.criteria).matches, false);
});

test('parses ideal iPhone storage and maximum budget', () => {
  const parsed = parseNaturalLanguageQuery('ищу хороший айфон 14 на 256 гигов в идеале до 25к');
  assert.equal(parsed.query, 'iPhone 14');
  assert.equal(parsed.criteria.maxPrice, 25000);
  assert.ok(parsed.criteria.includeTerms.includes('256 ГБ'));
});

test('normalizes common Cyrillic product spellings', () => {
  assert.equal(parseNaturalLanguageQuery('ищу аирподсы 2').query, 'AirPods 2');
  assert.equal(parseNaturalLanguageQuery('ищу самсунг гелекси 4').query, 'Samsung Galaxy 4');
  assert.equal(parseNaturalLanguageQuery('ищу айфон 11').query, 'iPhone 11');
});
