'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getBoundedTtlCacheValue, setBoundedTtlCacheValue } = require('./bounded-ttl-cache');

test('bounded TTL cache evicts least-recently-used entries at the configured cap', () => {
  const cache = new Map();
  setBoundedTtlCacheValue(cache, 'a', 'A', 1000, 3, 100);
  setBoundedTtlCacheValue(cache, 'b', 'B', 1000, 3, 100);
  setBoundedTtlCacheValue(cache, 'c', 'C', 1000, 3, 100);
  assert.equal(getBoundedTtlCacheValue(cache, 'a', 101), 'A');
  setBoundedTtlCacheValue(cache, 'd', 'D', 1000, 3, 101);
  assert.equal(cache.size, 3);
  assert.equal(getBoundedTtlCacheValue(cache, 'b', 102), undefined);
  assert.equal(getBoundedTtlCacheValue(cache, 'a', 102), 'A');
  assert.equal(getBoundedTtlCacheValue(cache, 'd', 102), 'D');
});

test('bounded TTL cache removes expired entries on reads and writes', () => {
  const cache = new Map();
  setBoundedTtlCacheValue(cache, 'expired', 'old', 10, 10, 100);
  assert.equal(getBoundedTtlCacheValue(cache, 'expired', 111), undefined);
  setBoundedTtlCacheValue(cache, 'another', 'value', 100, 10, 111);
  assert.equal(cache.has('expired'), false);
  assert.equal(cache.size, 1);
});

test('empty-string negative cache values are retained but remain bounded', () => {
  const cache = new Map();
  setBoundedTtlCacheValue(cache, 'empty', '', 60000, 2, 100);
  assert.equal(getBoundedTtlCacheValue(cache, 'empty', 101), '');
  setBoundedTtlCacheValue(cache, 'second', 'ok', 60000, 2, 101);
  setBoundedTtlCacheValue(cache, 'third', 'ok', 60000, 2, 102);
  assert.equal(cache.size, 2);
  assert.equal(getBoundedTtlCacheValue(cache, 'empty', 103), undefined);
});

test('listing description cache uses the bounded helper for both positive and negative results', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /getBoundedTtlCacheValue\(listingDescriptionCache, key\)/);
  assert.match(source, /setBoundedTtlCacheValue\(listingDescriptionCache, key, result, 10 \* 60 \* 1000, 500\)/);
  assert.match(source, /setBoundedTtlCacheValue\(listingDescriptionCache, key, '', 60 \* 1000, 500\)/);
  assert.doesNotMatch(source, /listingDescriptionCache\.set\(key/);
});
