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


test('parses iPhone 11 budget and normal-screen preference', () => {
  const parsed = parseNaturalLanguageQuery('ищу айфон 11 до 10к с норм экраном');
  assert.equal(parsed.query, 'айфон 11');
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
  assert.equal(parsed.query, 'айфон 14');
  assert.equal(parsed.criteria.maxPrice, 25000);
  assert.ok(parsed.criteria.includeTerms.includes('256 ГБ'));
});

test('normalizes common Cyrillic product spellings', () => {
  assert.equal(parseNaturalLanguageQuery('ищу аирподсы 2').query, 'AirPods 2');
  assert.equal(parseNaturalLanguageQuery('ищу самсунг гелекси 4').query, 'Samsung Galaxy 4');
  assert.equal(parseNaturalLanguageQuery('ищу айфон 11').query, 'айфон 11');
});


test('parses iPhone 15 with shorthand storage and Chernihiv city', () => {
  const parsed = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове');
  assert.equal(parsed.query, 'айфон 15');
  assert.equal(parsed.criteria.city, 'Чернігів');
  assert.ok(parsed.criteria.includeTerms.includes('256 ГБ'));

  assert.equal(applyCriteriaToListing({
    title: 'Apple iPhone 15 256GB',
    description: ''
  }, parsed.criteria).matches, true);

  assert.equal(applyCriteriaToListing({
    title: 'Apple iPhone 15 128 GB',
    description: ''
  }, parsed.criteria).matches, false);
});


test('matches iPhone storage written as a bare number in the title only', () => {
  const criteria = { includeTerms: ['256 ГБ'] };
  assert.equal(applyCriteriaToListing({
    title: 'Apple iPhone 15 256',
    description: ''
  }, criteria).matches, true);

  assert.equal(applyCriteriaToListing({
    title: 'Apple iPhone 15 128',
    description: ''
  }, criteria).matches, false);

  assert.equal(applyCriteriaToListing({
    title: 'Apple iPhone 15 256 МБ RAM',
    description: ''
  }, criteria).matches, false);
});


test('iPhone 15 base search keeps five local Pro-family listings in a separate similar block', () => {
  const { findSimilarPhoneListings, parseNaturalLanguageQuery, applyCriteriaToListing } = require('./smart-search');
  const parsed = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове');
  const criteria = { ...parsed.criteria, city: 'Чернігів' };
  const fixture = [
    { title: 'Iphone 15 pro 256 Gb фіз сім Natural Titanium29 500 грн.Договірна', price: 29500, link: 'local-1', cardText: 'Iphone 15 pro 256 Gb фіз сім Natural Titanium29 500 грн.Договірна Чернігів - 10 листопада 2026 р.' },
    { title: 'Айфон 15 про макс 256гб 100%17 000 грн.', price: 17000, link: 'local-2', cardText: 'Айфон 15 про макс 256гб 100%17 000 грн. Чернігів - 10 листопада 2026 р.' },
    { title: 'Телефон Iphone 15 Pro Max Apple Айфон30 500 грн.', price: 30500, link: 'local-3', cardText: 'Телефон Iphone 15 Pro Max Apple Айфон30 500 грн. Чернігів - 10 листопада 2026 р.' },
    { title: 'Продам iPhone 15 PRO MAX / 256 gb28 500 грн.', price: 28500, link: 'local-4', cardText: 'Продам iPhone 15 PRO MAX / 256 gb28 500 грн. Чернігів - 10 листопада 2026 р.' },
    { title: 'Продам IPhone 15 Pro Max 256 GB32 000 грн.', price: 32000, link: 'local-5', cardText: 'Продам IPhone 15 Pro Max 256 GB32 000 грн. Чернігів - 10 листопада 2026 р.' }
  ];
  const exact = fixture.filter(item => applyCriteriaToListing(item, criteria).matches);
  const similar = findSimilarPhoneListings(fixture, criteria, exact);
  assert.equal(exact.length, 0);
  assert.equal(similar.length, 5);
  assert.equal(similar.filter(item => !item.capacityUnverified).length, 4);
  assert.equal(similar.filter(item => item.capacityUnverified).length, 1);
  assert.equal(new Set([...exact, ...similar].map(item => item.link)).size, 5);
});

test('similar iPhone variants remain strict on explicit model, condition, city-filtered input, and price', () => {
  const { findSimilarPhoneListings, parseNaturalLanguageQuery } = require('./smart-search');
  const criteria = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове').criteria;
  const candidates = [
    { title: 'iPhone 15 Pro 256GB', price: 20000, link: 'ok', cardText: 'Стан: Вживане' },
    { title: 'iPhone 15 Pro Max 256GB', price: 40000, link: 'over-budget', cardText: 'Стан: Вживане' },
    { title: 'iPhone 15 Plus 128GB', price: 18000, link: 'wrong-memory', cardText: 'Стан: Вживане' },
    { title: 'iPhone 15 Pro 256GB', price: 20000, link: 'wrong-condition', cardText: 'Стан: Нове' }
  ];
  const similar = findSimilarPhoneListings(candidates, { ...criteria, maxPrice: 30000, condition: 'used' });
  assert.deepEqual(similar.map(item => item.link), ['ok']);
  assert.equal(findSimilarPhoneListings(candidates, { ...criteria, modelTerm: 'iPhone 15 Pro' }).length, 0);
  assert.equal(findSimilarPhoneListings(candidates, criteria, [], { explicitModelModifier: true }).length, 0);
});

test('foreign city listings are excluded before similar model classification', () => {
  const { findSimilarPhoneListings, parseNaturalLanguageQuery } = require('./smart-search');
  const fs = require('node:fs');
  const path = require('node:path');
  const criteria = parseNaturalLanguageQuery('куплю айфон 15 на 256 в чернигове').criteria;
  const cities = ['Ужгород','Київ','Суми','Харків','Умань','Кривий Ріг','Запоріжжя','Валки','Львів','Славута','Тернопіль','Одеса','Хмельницький','Полтава','Бердичів','Дніпро','Житомир'];
  const foreignCards = cities.map((city, index) => ({
    title: 'iPhone 15 Pro 256GB', price: 20000, link: 'foreign-' + index, city
  }));
  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(serverSource, /const locationItems = parsedItems\.filter\(/);
  assert.match(serverSource, /findSimilarPhoneListings\(locationItems, criteria/);
  assert.equal(foreignCards.length, 17);
});
