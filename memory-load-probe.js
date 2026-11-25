'use strict';

const cheerio = require('cheerio');
const { stripOlxNonContentMarkup } = require('./olx-html-utils');

if (typeof global.gc !== 'function') {
  throw new Error('Run with --expose-gc to measure stabilized heap');
}

const FIXTURE_BYTES = 3.4 * 1024 * 1024;
const SEQUENTIAL_RUNS = 50;
const PARALLEL_JOBS = 10;
const PARALLELISM = 2;
const HEAP_GROWTH_LIMIT = 48 * 1024 * 1024;
const RSS_GROWTH_LIMIT = 96 * 1024 * 1024;

function makeFixture() {
  const cards = Array.from({ length: 25 }, (_, index) =>
    '<article data-testid="l-card"><h3>iPhone 15 Pro Max 256 GB ' + index +
    '</h3><span>28 999 грн</span><a href="/d/item-' + index + '">open</a></article>'
  ).join('');
  const body = '<html><head><script type="application/json">{"payload":"' +
    'x'.repeat(FIXTURE_BYTES) + '"}</script><style>' + 'y'.repeat(32768) +
    '</style></head><body><main>' + cards + '</main></body></html>';
  return body;
}

function parseFixture() {
  let html = makeFixture();
  const responseBytes = Buffer.byteLength(html, 'utf8');
  let parseHtml = stripOlxNonContentMarkup(html);
  html = '';
  const $ = cheerio.load(parseHtml);
  parseHtml = '';
  const cards = $('[data-testid="l-card"]').length;
  if (cards !== 25 || responseBytes < FIXTURE_BYTES) {
    throw new Error('Parser fixture did not preserve expected listing cards');
  }
  return cards;
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return { heapUsed: memory.heapUsed, rss: memory.rss };
}

async function main() {
  global.gc();
  const baseline = memorySnapshot();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;

  for (let index = 0; index < SEQUENTIAL_RUNS; index++) {
    parseFixture();
    const current = memorySnapshot();
    peakHeap = Math.max(peakHeap, current.heapUsed);
    peakRss = Math.max(peakRss, current.rss);
    if ((index + 1) % 5 === 0) global.gc();
  }

  let nextJob = 0;
  let active = 0;
  let peakActive = 0;
  async function worker() {
    while (true) {
      const job = nextJob++;
      if (job >= PARALLEL_JOBS) return;
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(resolve => setImmediate(resolve));
      parseFixture();
      const current = memorySnapshot();
      peakHeap = Math.max(peakHeap, current.heapUsed);
      peakRss = Math.max(peakRss, current.rss);
      active--;
      if (job % 2 === 1) global.gc();
    }
  }
  await Promise.all(Array.from({ length: PARALLELISM }, () => worker()));
  global.gc();
  const final = memorySnapshot();
  const result = {
    fixtureBytes: Math.round(FIXTURE_BYTES),
    sequentialRuns: SEQUENTIAL_RUNS,
    parallelJobs: PARALLEL_JOBS,
    configuredParallelism: PARALLELISM,
    observedParallelism: peakActive,
    peakHeapUsedMiB: Number((peakHeap / 1048576).toFixed(1)),
    finalHeapUsedMiB: Number((final.heapUsed / 1048576).toFixed(1)),
    heapGrowthAfterGcMiB: Number(((final.heapUsed - baseline.heapUsed) / 1048576).toFixed(1)),
    peakRssMiB: Number((peakRss / 1048576).toFixed(1)),
    finalRssMiB: Number((final.rss / 1048576).toFixed(1)),
    rssGrowthMiB: Number(((final.rss - baseline.rss) / 1048576).toFixed(1)),
    heapGrowthLimitMiB: 48,
    rssGrowthLimitMiB: 96
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (peakActive > PARALLELISM ||
      final.heapUsed - baseline.heapUsed > HEAP_GROWTH_LIMIT ||
      final.rss - baseline.rss > RSS_GROWTH_LIMIT) {
    throw new Error('Memory regression threshold exceeded');
  }
}

main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
