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
