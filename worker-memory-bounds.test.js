'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('worker loads seen and price history only for current parsed links in bounded batches', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const workerStart = source.indexOf('async function runBackgroundWorker()');
  const workerEnd = source.indexOf('const MEMORY_ALERT_THRESHOLD_BYTES', workerStart);
  const worker = source.slice(workerStart, workerEnd);
  assert.match(worker, /parsedItemLinks = \[\.\.\.new Set\(parsedItems/);
  assert.match(worker, /for \(let offset = 0; offset < parsedItemLinks\.length; offset \+= 50\)/);
  assert.match(worker, /\.from\('seen_ads'\)[\s\S]*?\.in\('ad_link', linkBatch\)/);
  assert.match(worker, /priceItemLinks = \[\.\.\.new Set\(items/);
  assert.match(worker, /for \(let offset = 0; offset < priceItemLinks\.length; offset \+= 50\)/);
  assert.match(worker, /\.from\('ad_price_history'\)[\s\S]*?\.in\('ad_link', linkBatch\)/);
  assert.doesNotMatch(worker, /\.from\('seen_ads'\)\.select\('ad_link'\)\.eq\('filter_id', filter\.id\);/);
  assert.doesNotMatch(worker, /\.from\('ad_price_history'\)\.select\('ad_link,last_price'\)\.eq\('filter_id', String\(filter\.id\)\);/);
});
