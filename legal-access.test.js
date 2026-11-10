'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('terms and privacy API pages remain explicitly draft', () => {
  assert.match(server, /app\.get\('\/api\/legal\/terms'/);
  assert.match(server, /app\.get\('\/api\/legal\/privacy'/);
  const termsRoute = server.slice(server.indexOf("app.get('/api/legal/terms'"), server.indexOf("app.get('/api/legal/privacy'"));
  const privacyRoute = server.slice(server.indexOf("app.get('/api/legal/privacy'"), server.indexOf('const searchDiagnosticRateLimits'));
  assert.match(termsRoute, /status: 'draft'/);
  assert.match(privacyRoute, /status: 'draft'/);
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
  assert.match(html, /Володілець персональних даних і відповідальна особа: не підтверджені/);
  assert.match(html, /власник має внести перевірене повне ім’я або найменування/);
  assert.match(html, /@esqide/);
});
