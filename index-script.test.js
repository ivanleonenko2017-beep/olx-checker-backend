const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('all inline JavaScript in the Mini App parses successfully', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const executableScripts = scripts.filter(([, attributes, source]) =>
    !/\bsrc\s*=/i.test(attributes) &&
    !/application\/(?:ld\+json|json)/i.test(attributes) &&
    source.trim().length > 0
  );

  assert.ok(executableScripts.length > 0, 'expected at least one inline JavaScript block');
  executableScripts.forEach(([, , source]) => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: 'index.inline.js' }));
  });
});


test('admin metrics show a retryable Ukrainian error instead of silently keeping placeholders', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /id="adminStatsError"/);
  assert.match(html, /Не вдалося завантажити/);
  assert.match(html, /Повторити/);
  const fnStart = html.indexOf('async function loadAdminStats()');
  const fnEnd = html.indexOf('async function adminFindUser()', fnStart);
  const fn = html.slice(fnStart, fnEnd);
  assert.match(fn, /if \(!res\.ok\) throw/);
  assert.match(fn, /errorPanel\.classList\.remove\('hidden'\)/);
  assert.match(fn, /Number\(data\.stats\.totalUsers\)/);
});

test('administrator filter counter is explicitly labelled as unlimited admin access', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /isAdminUser \? 'Адмін · без ліміту'/);
});


test('OLX title normalization separates glued amount and negotiable label without losing model or capacity', () => {
  const { cleanOlxCardTitle, hasNegotiablePrice } = require('./olx-card-utils');
  assert.equal(
    cleanOlxCardTitle(
      'Iphone 15 pro 256 Gb фіз сім Natural Titanium29 500 грн.Договірна',
      '29 500 грн.Договірна'
    ),
    'Iphone 15 pro 256 Gb фіз сім Natural Titanium'
  );
  assert.equal(
    cleanOlxCardTitle('Айфон 15 про макс 256гб 100%17 000 грн.', '17 000 грн.'),
    'Айфон 15 про макс 256гб 100%'
  );
  assert.equal(
    cleanOlxCardTitle('Продам iPhone 15 PRO MAX / 256 gb28 500 грн.', '28 500 грн.'),
    'Продам iPhone 15 PRO MAX / 256 gb'
  );
  assert.equal(
    cleanOlxCardTitle('Продам IPhone 15 Pro Max 256 GB32 000 грн.', '32 000 грн.'),
    'Продам IPhone 15 Pro Max 256 GB'
  );
  assert.equal(cleanOlxCardTitle('iPhone 15 256 GB', '29 500 грн'), 'iPhone 15 256 GB');
  assert.equal(hasNegotiablePrice('29 500 грн.Договірна'), true);
  assert.equal(hasNegotiablePrice('29 500 грн'), false);
});

test('OLX parser stores title, numeric price, and negotiable flag as separate fields', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /const rawTitle =/);
  assert.match(source, /const sourcePriceText = priceElement\.text/);
  assert.match(source, /const title = cleanOlxCardTitle\(rawTitle, sourcePriceText\)/);
  assert.match(source, /priceText: numericPrice > 0/);
  assert.match(source, /isNegotiable,/);
  assert.match(source, /notificationPrice/);
});
