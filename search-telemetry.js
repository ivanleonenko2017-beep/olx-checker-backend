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
    url.pathname = url.pathname.replace(/\/q-[^/]+/i, '/q-REDACTED');
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.delete(key);
    }
    return url.toString().slice(0, maxLength);
  } catch {
    return safeText(input, maxLength);
  }
}

async function isAuthorizedAdmin(user, checkAdmin) {
  if (!user || !user.id || typeof checkAdmin !== 'function') return false;
  try { return Boolean(await checkAdmin(user.id)); } catch { return false; }
}

function hashUserId(value, secret) {
  if (value === null || value === undefined || !String(secret || '')) return null;
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex').slice(0, 12);
}

function summarizeCriteria(criteria = {}) {
  const capacity = [...(criteria.includeTerms || []), ...(criteria.anyTerms || [])]
    .map(value => String(value).match(/^(\d{2,4})\s*(?:гб|gb)$/iu)?.[1])
    .filter(Boolean);
  return {
    model: safeText(criteria.modelTerm || '', 60),
    memoryGb: [...new Set(capacity)].slice(0, 5),
    condition: safeText(criteria.condition || 'all', 12),
    city: safeText(criteria.city || '', 60),
    minPrice: Number(criteria.minPrice || 0) || 0,
    maxPrice: Number(criteria.maxPrice || 0) || 0,
    includeTermCount: Array.isArray(criteria.includeTerms) ? criteria.includeTerms.length : 0,
    anyTermCount: Array.isArray(criteria.anyTerms) ? criteria.anyTerms.length : 0,
    excludeTermCount: Array.isArray(criteria.excludeTerms) ? criteria.excludeTerms.length : 0
  };
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

module.exports = { safeText, sanitizeSearchUrl, hashUserId, compactRejectedCards, evaluateCriteriaFunnel, summarizeCriteria, isAuthorizedAdmin };
