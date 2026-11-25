'use strict';

function getBoundedTtlCacheValue(cache, key, now = Date.now()) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the oldest entry is evicted first.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setBoundedTtlCacheValue(cache, key, value, ttlMs = 60000, maxEntries = 500, now = Date.now()) {
  for (const [existingKey, entry] of cache) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      cache.delete(existingKey);
    }
  }
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + Math.max(1, Number(ttlMs) || 60000) });
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 500));
  while (cache.size > limit) {
    cache.delete(cache.keys().next().value);
  }
  return value;
}

module.exports = { getBoundedTtlCacheValue, setBoundedTtlCacheValue };
