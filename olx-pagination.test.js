const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOlxPageUrl, canonicalAdUrl, mergeUniqueOlxItems, shouldStopAfterNoLocalPage } = require('./olx-pagination');

test('builds subsequent OLX page URLs without dropping existing filters', () => {
  const first = 'https://www.olx.ua/uk/chernigov/q-iphone-15/?search%5Bfilter_float_price%3Ato%5D=20000';
  const second = new URL(buildOlxPageUrl(first, 2));
  assert.equal(second.searchParams.get('page'), '2');
  assert.equal(second.searchParams.get('search[filter_float_price:to]'), '20000');
  assert.equal(new URL(buildOlxPageUrl(second.toString(), 1)).searchParams.has('page'), false);
});

test('rejects invalid OLX page numbers', () => {
  assert.throws(() => buildOlxPageUrl('https://www.olx.ua/uk/list/', 0), RangeError);
  assert.throws(() => buildOlxPageUrl('https://www.olx.ua/uk/list/', 1.5), RangeError);
});

test('canonicalizes listing links and merges duplicate cards across pages', () => {
  assert.equal(
    canonicalAdUrl('https://www.olx.ua/d/uk/obyavlenie/example/?reason=extended_search#top'),
    'https://www.olx.ua/d/uk/obyavlenie/example'
  );
  const merged = mergeUniqueOlxItems([
    [{ link: 'https://www.olx.ua/d/uk/obyavlenie/a/?tracking=1', title: 'A' }],
    [
      { link: 'https://www.olx.ua/d/uk/obyavlenie/a/', title: 'A duplicate' },
      { link: 'https://www.olx.ua/d/uk/obyavlenie/b/', title: 'B' }
    ]
  ]);
  assert.deepEqual(merged.map(item => item.title), ['A', 'B']);
});


test('stops pagination after the first foreign-only page following local results', () => {
  assert.equal(shouldStopAfterNoLocalPage(true, 0), true);
  assert.equal(shouldStopAfterNoLocalPage(false, 0), false);
});

test('continues pagination while the current page still contains local listings', () => {
  assert.equal(shouldStopAfterNoLocalPage(true, 1), false);
  assert.equal(shouldStopAfterNoLocalPage(true, 5), false);
});
