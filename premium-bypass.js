'use strict';

function isRenderRuntime(env = process.env) {
  return String(env.RENDER || '').toLowerCase() === 'true' ||
    Boolean(env.RENDER_SERVICE_ID) ||
    Boolean(env.RENDER_INSTANCE_ID);
}

function isTestPremiumBypassEnabled(env = process.env) {
  if (env.NODE_ENV !== 'test' || isRenderRuntime(env)) return false;
  return env.ENABLE_TEST_PREMIUM_BYPASS === 'true';
}

module.exports = { isRenderRuntime, isTestPremiumBypassEnabled };
