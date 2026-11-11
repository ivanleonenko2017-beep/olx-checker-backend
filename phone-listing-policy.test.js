'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isNonPhoneOfferTitle, isAccessoryIntent, isRepairPartsListing } = require('./smart-search');

const phoneTitles = [
  'Айфон 14 на 128gb',
  'Продам Iphone 14, 128 gb, в хорошем состоянии',
  'НОВИЙ Open Box Apple iPhone 14 Pro Deep Purple 256 Gb Never Lock',
  'Iphone 14 pro 256 магазин, гарантія',
  'Iphone 14 pro 128 gb, гарний стан',
  'Айфон 14 про 256 чорний, айфон 16 про макс 256 чорний',
  'Айфон 14 про на 256 гб',
  'iPhone 14 Pro б/у',
  'Айфон 14 про макс',
  'Iphone 14 pro max neverlock'
];
const accessoryTitles = [
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
];

test('the 27 supplied iPhone 14 fixture titles split into 10 phones and 17 accessories', () => {
  assert.equal(phoneTitles.filter(title => !isNonPhoneOfferTitle(title)).length, 10);
  assert.equal(accessoryTitles.filter(title => isNonPhoneOfferTitle(title)).length, 17);
  assert.deepEqual(accessoryTitles.filter(title => !isNonPhoneOfferTitle(title)), []);
});

test('accessory words after the phone noun do not reject a phone listing', () => {
  assert.equal(isNonPhoneOfferTitle('iPhone 14 Pro 128, чохол у подарунок'), false);
  assert.equal(isNonPhoneOfferTitle('iPhone 14 Pro 128, з зарядкою, коробка'), false);
});

test('buyer intent is excluded even when a phone model follows', () => {
  assert.equal(isNonPhoneOfferTitle('куплю айфон 14'), true);
  assert.equal(isNonPhoneOfferTitle('Скуплю iPhone 14 Pro'), true);
});

test('repair/parts offers remain distinguishable from accessories', () => {
  const title = 'Оригінал iPhone 14 на запчастини';
  assert.equal(isNonPhoneOfferTitle(title), false);
  assert.equal(isRepairPartsListing(title), true);
});

test('accessory query intent is preserved separately from phone model intent', () => {
  assert.equal(isAccessoryIntent('чохол на айфон 14'), true);
  assert.equal(isAccessoryIntent('iPhone 14 Pro 128, чохол у подарунок'), false);
});
