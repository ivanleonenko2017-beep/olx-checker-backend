'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const legalDocuments = require('./legal-documents').LEGAL_DOCUMENTS;

test('terms and privacy API pages remain explicitly draft', () => {
  assert.match(server, /app\.get\('\/api\/legal\/terms'/);
  assert.match(server, /app\.get\('\/api\/legal\/privacy'/);
  assert.equal(legalDocuments.terms.status, 'draft');
  assert.equal(legalDocuments.privacy.status, 'draft');
  assert.match(server, /LEGAL_DOCUMENTS\.terms/);
  assert.match(server, /LEGAL_DOCUMENTS\.privacy/);
});

test('Mini App document deep links open the matching document in Documents tab', () => {
  assert.match(html, /get\('document'\)/);
  assert.match(html, /switchTab\('documents'\)/);
  assert.match(html, /openLegalDoc\(requestedLegalDoc\)/);
  assert.match(html, /id="tab-documents"/);
});

test('Telegram bot provides separate terms and privacy links without claiming approval', () => {
  assert.match(server, /text\.startsWith\('\/terms'\)/);
  assert.match(server, /text\.startsWith\('\/privacy'\)/);
  assert.match(server, /document=terms/);
  assert.match(server, /document=privacy/);
  assert.match(server, /не юридично затверджений документ/);
  assert.match(server, /Поточна редакція — проєкт/);
});

test('legal pages do not assert an unverified owner identity or invented registration details', () => {
  assert.doesNotMatch(html, /Іван Леоненко/);
  const legalText = legalDocuments.privacy.content.join(' ');
  assert.match(legalText, /Володілець персональних даних і відповідальна особа: не підтверджені/);
  assert.match(legalText, /власник має внести перевірене повне ім’я або найменування/i);
  assert.match(legalText, /@esqide/);
});
