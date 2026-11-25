'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildListingNotification } = require('./telegram-notification');

test('listing notification formatter keeps escaped content and both real action buttons', () => {
  const result = buildListingNotification({
    item: {
      title: '<iPhone> & accessory',
      price: 28999,
      priceText: '28 999 грн',
      link: 'https://www.olx.ua/uk/list/q-iphone-15/',
      locationDate: 'Чернігів · сьогодні',
      modelVersion: 'iPhone 15 Pro Max',
      capacityUnverified: true
    },
    filter: { query: 'iPhone 15 256 GB' },
    serverUrl: 'https://znaideno.example'
  });
  assert.match(result.text, /&lt;iPhone&gt; &amp; accessory/);
  assert.match(result.text, /iPhone 15 Pro Max/);
  assert.match(result.text, /Обсяг пам’яті не підтверджено/);
  assert.equal(result.keyboard.inline_keyboard[0][0].url, 'https://www.olx.ua/uk/list/q-iphone-15/');
  assert.equal(result.keyboard.inline_keyboard[1][0].web_app.url, 'https://znaideno.example');
  assert.equal(result.photoToSend, 'https://znaideno.example/assets/no-photo.png');
});

test('test notification is visibly marked and uses the same formatter and action layout', () => {
  const result = buildListingNotification({
    item: { title: 'Тестовий телефон', price: 1000, priceText: '1 000 грн', link: 'https://www.olx.ua/' },
    filter: { query: 'Тестовий фільтр' },
    serverUrl: 'https://znaideno.example',
    testMode: true
  });
  assert.match(result.text, /ТЕСТ · Перевірка формату сповіщення/);
  assert.match(result.text, /Знайдено нове оголошення для фільтра/);
  assert.equal(result.keyboard.inline_keyboard.length, 2);
});

test('admin testnotify is authenticated, rate-limited, and sends only to the invoking admin', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const command = source.match(/const adminCommandMatch = text\.match\(([^;]+)\);/);
  assert.ok(command);
  assert.match(command[1], /testnotify/);
  const authIndex = source.indexOf('isAdminCommandAuthorized(senderId, checkIsAdmin)');
  const handlerIndex = source.indexOf("if (command === 'testnotify')");
  assert.ok(authIndex >= 0 && handlerIndex > authIndex);
  const handler = source.slice(handlerIndex, source.indexOf("if (command === 'sub' || command === 'ref')", handlerIndex));
  assert.match(handler, /consumeRateLimit\(testNotificationRateLimits, adminKey\)/);
  assert.match(handler, /sendTelegramPhoto\(\s*chatId/);
  assert.doesNotMatch(handler, /\.from\(/);
  assert.doesNotMatch(handler, /filter\.user_id/);
});
