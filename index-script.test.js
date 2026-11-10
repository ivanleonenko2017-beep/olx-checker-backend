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
