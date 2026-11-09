const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeTelegramHtml } = require('./telegram-html');

test('escapes untrusted OLX/user text for Telegram HTML mode', () => {
  assert.equal(
    escapeTelegramHtml('<b>iPhone</b> & "sale"'),
    '&lt;b&gt;iPhone&lt;/b&gt; &amp; &quot;sale&quot;'
  );
});

test('preserves ordinary Unicode text', () => {
  assert.equal(escapeTelegramHtml('Чернігів — айфон 15'), 'Чернігів — айфон 15');
});
