'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripOlxNonContentMarkup } = require('./olx-html-utils');

test('OLX parser input strips large scripts and styles while preserving listing markup', () => {
  const html = '<html><head><script type="application/json">{"payload":"' + 'x'.repeat(1000) +
    '"}</script><style>.huge{color:red}</style></head><body>' +
    '<article data-testid="l-card"><h3>iPhone 15</h3><a href="/d/item">open</a></article>' +
    '</body></html>';
  const cleaned = stripOlxNonContentMarkup(html);
  assert.doesNotMatch(cleaned, /<script|<style|payload|huge/);
  assert.match(cleaned, /<article data-testid="l-card">/);
  assert.match(cleaned, /<h3>iPhone 15<\/h3>/);
  assert.match(cleaned, /href="\/d\/item"/);
});

test('OLX parser markup cleanup handles empty input and multiline script tags', () => {
  assert.equal(stripOlxNonContentMarkup(''), '');
  const cleaned = stripOlxNonContentMarkup('<script>\n large \n payload\n</script><div>card</div>');
  assert.equal(cleaned, '<div>card</div>');
});

test('production parser caps OLX response size and drops raw HTML before Cheerio parsing', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /maxContentLength: 5 \* 1024 \* 1024/);
  assert.match(source, /response\.data = null/);
  assert.match(source, /stripOlxNonContentMarkup\(html\)/);
  assert.match(source, /html = ''/);
});

test('empty-page parser guard uses a marker captured before the raw HTML is released', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /const pageHasSearchMarkers = \/search\|listing\|og:\/i\.test\(html\)/);
  assert.match(source, /!pageHasSearchMarkers/);
  assert.doesNotMatch(source, /test\(pageText\)/);
});
