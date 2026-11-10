'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isRenderRuntime, isTestPremiumBypassEnabled } = require('./premium-bypass');

test('test premium bypass is available only in an explicit local test runtime', () => {
  assert.equal(isTestPremiumBypassEnabled({
    NODE_ENV: 'test',
    ENABLE_TEST_PREMIUM_BYPASS: 'true'
  }), true);
});

test('test premium bypass is disabled in production even when explicitly enabled', () => {
  assert.equal(isTestPremiumBypassEnabled({
    NODE_ENV: 'production',
    ENABLE_TEST_PREMIUM_BYPASS: 'true'
  }), false);
});

test('test premium bypass is disabled on Render even if NODE_ENV is test', () => {
  assert.equal(isTestPremiumBypassEnabled({
    NODE_ENV: 'test',
    RENDER: 'true',
    ENABLE_TEST_PREMIUM_BYPASS: 'true'
  }), false);
  assert.equal(isTestPremiumBypassEnabled({
    NODE_ENV: 'test',
    RENDER_SERVICE_ID: 'srv-example',
    ENABLE_TEST_PREMIUM_BYPASS: 'true'
  }), false);
  assert.equal(isRenderRuntime({ RENDER_INSTANCE_ID: 'srv-example-instance' }), true);
});

test('test premium bypass fails closed when the flag is absent or false', () => {
  assert.equal(isTestPremiumBypassEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(isTestPremiumBypassEnabled({
    NODE_ENV: 'test',
    ENABLE_TEST_PREMIUM_BYPASS: 'false'
  }), false);
});
