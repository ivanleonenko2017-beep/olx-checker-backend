'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LEGAL_DOCUMENTS } = require('./legal-documents');

test('both legal documents are explicitly draft and contain no invented owner details', () => {
  for (const key of ['terms', 'privacy']) {
    const document = LEGAL_DOCUMENTS[key];
    assert.equal(document.status, 'draft');
    assert.ok(document.content.length >= 8);
    assert.ok(document.content.join(' ').includes('@esqide'));
    assert.match(document.content.join(' '), /не підтверджен|має вказати|має визначити/iu);
    assert.doesNotMatch(document.title + document.content.join(' '), /OLX Checker/i);
  }
});

test('server serves standalone /terms and /privacy from the same shared document object as the API', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /const \{ LEGAL_DOCUMENTS \} = require\('\.\/legal-documents'\)/);
  assert.match(source, /app\.get\('\/api\/legal\/terms'/);
  assert.match(source, /app\.get\('\/api\/legal\/privacy'/);
  assert.match(source, /app\.get\('\/terms'/);
  assert.match(source, /app\.get\('\/privacy'/);
  assert.match(source, /renderLegalDocumentPage\('terms'\)/);
  assert.match(source, /renderLegalDocumentPage\('privacy'\)/);
});

test('Mini App documents tab labels both documents as drafts and loads the shared API', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /Публічна оферта · чернетка/);
  assert.match(html, /Політика конфіденційності · чернетка/);
  assert.match(html, /fetch\(\`\$\{BACKEND_URL\}\/api\/legal\/\$\{safeType\}\`\)/);
  assert.match(html, /documentData\.status !== 'draft'/);
  assert.doesNotMatch(html, /ПУБЛІЧНА ОФЕРТА ЗНАЙДЕНО/);
  assert.doesNotMatch(html, /ПОЛІТИКА КОНФІДЕНЦІЙНОСТІ ЗНАЙДЕНО/);
});
