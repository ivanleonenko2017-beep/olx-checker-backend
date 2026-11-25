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
