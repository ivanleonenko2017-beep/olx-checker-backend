'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPhoneMarketAnalytics } = require('./smart-search');

const phones = [
  ['Айфон 14 на 128gb', 15000],
  ['Продам Iphone 14, 128 gb, в хорошем состоянии', 17500],
  ['НОВИЙ Open Box Apple iPhone 14 Pro Deep Purple 256 Gb Never Lock', 28999],
  ['Iphone 14 pro 256 магазин, гарантія', 19800],
  ['Iphone 14 pro 128 gb, гарний стан', 18700],
  ['Айфон 14 про 256 чорний, айфон 16 про макс 256 чорний', 24000],
  ['Айфон 14 про на 256 гб', 27000],
  ['iPhone 14 Pro б/у', 25000],
  ['Айфон 14 про макс', 16500],
  ['Iphone 14 pro max neverlock', 17500]
].map(([title, price]) => ({ title, price }));

const accessories = [
  'чехлы на айфон 14',
  'Зарядний пристрій для Айфон 14 в ідеалі',
  'Чохол на айфон 14 про макс',
  'Чохол на айфон 14 про макс з блискітками',
  'Чохол на айфон 14 про макс силіконовий',
  'Чохли на айфон 14 плюс',
  'Корпус Айфон 14 про макс оригінал є-сім',
  'Продам 12 чехлов на айфон 14про',
  'Чохол для айфон 14 pro',
  'Чохол на айфон 14 pro max',
  'Чехол на айфон 14 промакс',
  'Чохли на iphone 14 pro max',
  'Чехол айфон 14 промакс',
  'Чохли на iphone 14 pro',
  'Чохол овечка Iphone 14 pro',
  'Продам чохол на Iphone 14 pro-max',
  'Чохол на смартфон Iphone 14 Promax'
].map((title, index) => ({ title, price: 100 + index }));

test('iPhone 14 analytics counts only phones and groups medians by version', () => {
  const result = buildPhoneMarketAnalytics([...phones, ...accessories], {
    modelTerm: 'iPhone 14',
    modelScope: 'all'
  });
  assert.deepEqual(result.groups.map(group => [group.version, group.count]), [
    ['Базова', 2], ['Plus', 0], ['Pro', 6], ['Pro Max', 2]
  ]);
  assert.equal(result.groups.find(group => group.version === 'Базова').medianPrice, null);
  assert.equal(result.groups.find(group => group.version === 'Базова').statusLabel, 'Недостатньо даних');
  assert.equal(result.groups.find(group => group.version === 'Pro').medianPrice, 24500);
  assert.equal(result.groups.find(group => group.version === 'Pro Max').medianPrice, null);
});

test('repair-parts and unverified-capacity listings do not enter market medians', () => {
  const comparable = phones.filter(item => item.title.toLowerCase().includes('pro ') && !item.title.toLowerCase().includes('pro max'));
  const items = [
    ...comparable,
    { title: 'iPhone 14 Pro 256GB на запчастини', price: 1000, partsOnly: true },
    { title: 'iPhone 14 Pro 256GB', price: 15000, capacityUnverified: true }
  ];
  const result = buildPhoneMarketAnalytics(items, {
    modelTerm: 'iPhone 14',
    modelScope: 'pro',
    includeTerms: ['256 ГБ']
  });
  assert.equal(result.memory, '256 ГБ');
  assert.equal(result.groups[0].version, 'Pro');
  assert.equal(result.groups[0].count, 5);
  assert.equal(result.groups[0].medianPrice, 24000);
});
