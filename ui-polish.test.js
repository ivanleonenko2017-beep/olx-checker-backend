'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('Mini App supports Telegram viewport safe areas and theme changes', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /env\(safe-area-inset-top\)/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
  assert.match(html, /themeParams/);
  assert.match(html, /themeChanged/);
  assert.match(html, /data-tg-theme/);
});

test('Mini App exposes accessible focus and minimum touch target styles', () => {
  assert.match(html, /button:focus-visible/);
  assert.match(html, /outline-offset:3px/);
  assert.match(html, /button,a\[role="button"\],\.nav-btn \{ min-height:44px/);
  assert.match(html, /input,select,textarea \{ min-height:44px/);
});

test('Mini App removes decorative gradients, glass blur and heavy shadows', () => {
  assert.match(html, /background-image:none!important/);
  assert.match(html, /box-shadow:none!important/);
  assert.match(html, /backdrop-filter:none!important/);
  assert.match(html, /--zd-radius-lg:16px/);
  assert.match(html, /\\.rounded-full \\{ border-radius:999px!important; \\}/);
  assert.match(html, /--zd-space-1:4px/);
  assert.match(html, /--zd-space-2:8px/);
});

test('Mini App wires Telegram BackButton and haptic feedback safely', () => {
  assert.match(html, /tg\.BackButton\.onClick/);
  assert.match(html, /tg\.HapticFeedback\.impactOccurred/);
});

test('all inline JavaScript blocks parse and listing images are lazy-loaded', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script[1]));
  const images = [...html.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
  assert.ok(images.length > 0);
  assert.ok(images.every(image => /loading="lazy"/.test(image) && /decoding="async"/.test(image)));
});
