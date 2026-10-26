const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 80;

function normalizeTermList(value) {
  const input = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/)
      : [];

  const unique = [];
  const seen = new Set();

  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const term = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TERM_LENGTH);
    const key = term.toLocaleLowerCase('uk-UA');
    if (!term || seen.has(key)) continue;
    seen.add(key);
    unique.push(term);
    if (unique.length >= MAX_TERMS) break;
  }

  return unique;
}

function toPositiveInteger(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeCriteria(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const minPrice = toPositiveInteger(source.minPrice ?? source.min_price, 0);
  const maxPrice = toPositiveInteger(source.maxPrice ?? source.max_price, 0);
  const maxDiscountPercent = toPositiveInteger(source.maxDiscountPercent, 15);

  return {
    includeTerms: normalizeTermList(source.includeTerms ?? source.include_terms),
    excludeTerms: normalizeTermList(source.excludeTerms ?? source.exclude_terms),
    condition: ['all', 'new', 'used'].includes(String(source.condition || 'all').toLowerCase())
      ? String(source.condition || 'all').toLowerCase()
      : 'all',
    city: typeof source.city === 'string' ? source.city.trim().slice(0, 100) : '',
    photosOnly: source.photosOnly === true || source.photos_only === true,
    minPrice,
    maxPrice: maxPrice && minPrice && maxPrice < minPrice ? minPrice : maxPrice,
    bargainHunter: source.bargainHunter === true || source.bargain_hunter === true,
    maxDiscountPercent: Math.min(90, Math.max(5, maxDiscountPercent)),
    minComparableListings: Math.min(30, Math.max(3, toPositiveInteger(source.minComparableListings, 5)))
  };
}

function matchesTerms(text, terms, mode = 'all') {
  const haystack = String(text || '').toLocaleLowerCase('uk-UA');
  if (!terms.length) return true;
  const hits = terms.map(term => haystack.includes(term.toLocaleLowerCase('uk-UA')));
  return mode === 'any' ? hits.some(Boolean) : hits.every(Boolean);
}

function applyCriteriaToListing(listing, criteriaInput = {}) {
  const criteria = normalizeCriteria(criteriaInput);
  const text = [listing?.title, listing?.description].filter(Boolean).join(' ');
  const lowerText = text.toLocaleLowerCase('uk-UA');
  const price = toPositiveInteger(listing?.price, 0);

  if (criteria.includeTerms.length && !matchesTerms(lowerText, criteria.includeTerms, 'all')) {
    return { matches: false, reason: 'missing_required_term', criteria };
  }
  if (criteria.excludeTerms.some(term => lowerText.includes(term.toLocaleLowerCase('uk-UA')))) {
    return { matches: false, reason: 'excluded_term', criteria };
  }
  if (criteria.minPrice && (!price || price < criteria.minPrice)) {
    return { matches: false, reason: 'below_min_price', criteria };
  }
  if (criteria.maxPrice && (!price || price > criteria.maxPrice)) {
    return { matches: false, reason: 'above_max_price', criteria };
  }
  // parseOlx always supplies proxyImg, including the no-photo fallback.
  // Treat only real image URLs as photos so photosOnly does not match every card.
  const imageCandidates = [listing?.rawImgUrl, listing?.img, listing?.imageUrl, listing?.proxyImg]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
  const hasPhoto = imageCandidates.some(value =>
    !/(?:no-photo|noimage|placeholder|blank\\.gif)(?:[?#]|$)/i.test(value)
  );
  if (criteria.photosOnly && !hasPhoto) {
    return { matches: false, reason: 'photos_required', criteria };
  }
  if (criteria.condition !== 'all') {
    const isNew = /\b(нове|новий|нова|нові|новый|новая|новое|новые)\b/i.test(text);
    const isUsed = /\b(б\/у|бу|вживан|уживан|used|після використання)\b/i.test(text);
    if (criteria.condition === 'new' && !isNew) return { matches: false, reason: 'condition_mismatch', criteria };
    if (criteria.condition === 'used' && !isUsed) return { matches: false, reason: 'condition_mismatch', criteria };
  }

  return { matches: true, reason: null, criteria };
}

function parseNaturalLanguageQuery(input) {
  const original = String(input || '').trim().replace(/\s+/g, ' ');
  let remaining = original;
  const criteria = {};

  const pricePatterns = [
    { regex: /(?:до|не дорожче|максимум|бюджет(?:ом)? до)\s*(\d[\d\s.,]*)\s*(?:грн|₴|гривень)?/i, key: 'maxPrice' },
    { regex: /(?:від|мінімум)\s*(\d[\d\s.,]*)\s*(?:грн|₴|гривень)?/i, key: 'minPrice' }
  ];
  for (const pattern of pricePatterns) {
    const match = remaining.match(pattern.regex);
    if (match) {
      const number = Number(match[1].replace(/[\s.,]/g, ''));
      if (Number.isSafeInteger(number) && number >= 0) criteria[pattern.key] = number;
      remaining = remaining.replace(match[0], ' ').trim();
    }
  }

  if (/\b(не показувати|без|виключити)\s+[^,;]+/i.test(remaining)) {
    const match = remaining.match(/\b(?:не показувати|без|виключити)\s+([^,;]+)/i);
    if (match) {
      criteria.excludeTerms = normalizeTermList(match[1].split(/\s+та\s+|\s+і\s+|\s+або\s+/i));
      remaining = remaining.replace(match[0], ' ').trim();
    }
  }

  if (/\b(новий|нова|нове|нові|новый|новая|новое|новые)\b/i.test(remaining)) criteria.condition = 'new';
  else if (/\b(б\/у|бу|вживаний|вживана|уживаний|used)\b/i.test(remaining)) criteria.condition = 'used';

  if (/\b(з фото|тільки з фото|лише з фото|с фото)\b/i.test(remaining)) {
    criteria.photosOnly = true;
    remaining = remaining.replace(/\b(з фото|тільки з фото|лише з фото|с фото)\b/ig, ' ').trim();
  }

  criteria.query = remaining.replace(/[;,]+/g, ' ').replace(/\s+/g, ' ').trim() || original;
  return { original, criteria: normalizeCriteria(criteria), query: criteria.query };
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function estimateBargainPrice(listingPrice, comparablePrices, options = {}) {
  const required = Math.min(30, Math.max(3, toPositiveInteger(options.minComparableListings, 5)));
  const discountThreshold = Math.min(90, Math.max(5, toPositiveInteger(options.discountPercent, 15)));
  const validPrices = (Array.isArray(comparablePrices) ? comparablePrices : [])
    .filter(price => Number.isFinite(price) && price > 0);
  const referencePrice = median(validPrices);
  if (!Number.isFinite(listingPrice) || listingPrice <= 0 || referencePrice === null || validPrices.length < required) {
    return { isBargain: false, referencePrice, comparableCount: validPrices.length, discountPercent: null, reliable: false };
  }
  const discountPercent = Math.round((1 - listingPrice / referencePrice) * 100);
  return {
    isBargain: discountPercent >= discountThreshold,
    referencePrice,
    comparableCount: validPrices.length,
    discountPercent,
    reliable: true
  };
}

module.exports = {
  normalizeTermList,
  normalizeCriteria,
  matchesTerms,
  applyCriteriaToListing,
  parseNaturalLanguageQuery,
  median,
  estimateBargainPrice
};
