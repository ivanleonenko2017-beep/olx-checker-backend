'use strict';

const crypto = require('node:crypto');
const { applyCriteriaToListing, canUseUnverifiedStorageFallback } = require('./smart-search');

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


function evaluateCriteriaFunnel(items, criteria = {}) {
  const stages = [
    ['model', { modelTerm: criteria.modelTerm }],
    ['memory', {
      includeTerms: criteria.includeTerms, anyTerms: criteria.anyTerms,
      includeTermsMode: criteria.includeTermsMode
    }],
    ['excluded_words', { excludeTerms: criteria.excludeTerms }],
    ['price', { minPrice: criteria.minPrice, maxPrice: criteria.maxPrice }],
    ['condition', { condition: criteria.condition }],
    ['other', { maxAgeMinutes: criteria.maxAgeMinutes, photosOnly: criteria.photosOnly }]
  ];
  let current = Array.isArray(items) ? items : [];
  const counts = { parsedAfterCity: current.length };
  const rejected = [];
  let capacityUnverified = 0;

  for (const [stage, stageCriteria] of stages) {
    if (stage === 'memory') {
      const strict = [];
      for (const item of current) {
        const result = applyCriteriaToListing(item, stageCriteria);
        if (result.matches) {
          strict.push(item);
          continue;
        }
        if (result.reason === 'missing_required_term' &&
            canUseUnverifiedStorageFallback(item, criteria)) {
          strict.push(item);
          capacityUnverified++;
          continue;
        }
        rejected.push({ item, stage, reason: result.reason || 'memory_mismatch' });
      }
      current = strict;
      counts.afterMemoryStrict = current.length - capacityUnverified;
      counts.afterMemoryIncludingUnverified = current.length;
      continue;
    }

    const passed = [];
    for (const item of current) {
      const result = applyCriteriaToListing(item, stageCriteria);
      if (result.matches) passed.push(item);
      else rejected.push({ item, stage, reason: result.reason || stage + '_mismatch' });
    }
    current = passed;
    counts['after_' + stage] = current.length;
  }

  return { counts, capacityUnverified, finalCount: current.length, rejected };
}

module.exports = { safeText, sanitizeSearchUrl, hashUserId, compactRejectedCards, evaluateCriteriaFunnel };
