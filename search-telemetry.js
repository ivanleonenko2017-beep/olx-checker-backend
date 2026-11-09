'use strict';

const crypto = require('node:crypto');

const SENSITIVE_QUERY_KEYS = /^(?:token|access_token|auth|authorization|hash|signature|password|passwd|secret|initdata|user|cookie|session)$/i;

function safeText(value, maxLength = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeSearchUrl(input, maxLength = 500) {
  try {
    const url = new URL(String(input || ''));
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.delete(key);
    }
    return url.toString().slice(0, maxLength);
  } catch {
    return safeText(input, maxLength);
  }
}

function hashUserId(value, secret) {
  if (value === null || value === undefined || !String(secret || '')) return null;
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex').slice(0, 12);
}

function compactRejectedCards(cards, limit = 25) {
  const list = Array.isArray(cards) ? cards : [];
  return {
    cards: list.slice(0, limit).map(card => ({
      listingKey: safeText(card.listingKey, 16),
      url: sanitizeSearchUrl(card.url),
      stage: safeText(card.stage, 40),
      reason: safeText(card.reason, 60),
      value: safeText(card.value, 100)
    })),
    omitted: Math.max(0, list.length - limit)
  };
}

module.exports = { safeText, sanitizeSearchUrl, hashUserId, compactRejectedCards };
