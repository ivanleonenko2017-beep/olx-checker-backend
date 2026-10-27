const MAX_TERMS = 50;
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

function expandDefectExclusions(terms) {
  const output = [...normalizeTermList(terms)];
  const groups = [
    {
      pattern: /поломан|слом|зламан|несправ|неисправ|не работает|не працює|не включ|не вмикається/i,
      terms: ['поломаний', 'поломанный', 'зламаний', 'сломанный', 'несправний', 'неисправный', 'не работает', 'не працює', 'не включается', 'не вмикається']
    },
    {
      pattern: /заблок|icloud|айклауд|activation lock|блокуван.{0,15}активац/i,
      terms: ['заблокований', 'заблокирован', 'icloud', 'айклауд', 'activation lock', 'блокування активації', 'активаційне блокування']
    },
    {
      pattern: /(?:розбит|разбит|тріс|трес|трещин|тріщин|скол|бит(?:ий|ое|ый)).{0,20}(?:скло|стекл|екран|экран)?|(?:скло|стекл|екран|экран).{0,20}(?:розбит|разбит|тріс|трес|трещин|тріщин|пошкодж|поврежд)/i,
      terms: ['розбите скло', 'разбитое стекло', 'тріснуте скло', 'треснутое стекло', 'тріщина', 'трещина', 'битий екран', 'битый экран', 'скол']
    },
    {
      pattern: /(?:(?:несправ|неисправ|не держит|не тримає|не трима|слабк|умира|degraded|faulty|bad).{0,24}(?:батар|акумулятор|battery)|(?:батар|акумулятор|battery).{0,24}(?:не держит|не тримає|не трима|несправ|неисправ|слабк|умира|faulty|bad))/i,
      terms: ['несправна батарея', 'неисправная батарея', 'батарея не держит заряд', 'акумулятор не тримає заряд', 'не тримає заряд', 'не держит заряд', 'battery faulty', 'battery health issue']
    }
  ];
  for (const group of groups) {
    if (output.some(term => group.pattern.test(term.toLocaleLowerCase('uk-UA')))) {
      output.push(...group.terms);
    }
  }
  const hasBatteryDefect = output.some(term =>
    /батар|акумулятор|battery/i.test(term) &&
    /несправ|неисправ|не держ|не трима|слабк|умира|faulty|bad/i.test(term)
  );
  if (hasBatteryDefect) {
    output.push('несправна батарея', 'неисправная батарея', 'батарея не держит заряд', 'акумулятор не тримає заряд', 'не тримає заряд', 'не держит заряд', 'battery faulty', 'battery health issue');
  }
  return normalizeTermList(output);
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
    anyTerms: normalizeTermList(source.anyTerms ?? source.any_terms),
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
    minComparableListings: Math.min(30, Math.max(3, toPositiveInteger(source.minComparableListings, 5))),
    maxAgeMinutes: Math.min(10080, Math.max(0, toPositiveInteger(source.maxAgeMinutes ?? source.max_age_minutes, 0))),
    includeTermsMode: source.includeTermsMode === 'any' || source.include_terms_mode === 'any' ? 'any' : 'all'
  };
}

function termMatches(haystack, rawTerm) {
  const term = String(rawTerm || '').toLocaleLowerCase('uk-UA');
  if (haystack.includes(term)) return true;

  // OLX sellers commonly write phone storage as "128GB", "128 GB", "128ГБ"
  // or "128 ГБ". Treat these as equivalent for explicit capacity filters.
  const phoneStorage = term.match(/^(\d{2,4})\s*(?:gb|гб)$/iu);
  if (phoneStorage) {
    const capacityPattern = new RegExp('(?:^|[^\\d])' + phoneStorage[1] + '\\s*(?:gb|гб)(?=$|[^\\p{L}])', 'iu');
    if (capacityPattern.test(haystack)) return true;
  }

  const ramRequirement = term.match(/(\d{1,3})\s*(?:гб|gb)/iu);
  if (ramRequirement && /(?:ram|озу|оператив|пам.?ят)/iu.test(term)) {
    const values = [...haystack.matchAll(/(\d{1,3})\s*(?:гб|gb)\s*(?:ram|озу|оператив\w*\s+пам\w*)/giu)]
      .map(match => Number(match[1]));
    return values.some(value => value >= Number(ramRequirement[1]));
  }

  const storageRequirement = term.match(/(\d{1,4})\s*(гб|gb|тб|tb)/iu);
  if (storageRequirement && /(?:ssd|накопичувач|storage)/iu.test(term)) {
    const required = Number(storageRequirement[1]) * (/^(?:тб|tb)$/i.test(storageRequirement[2]) ? 1024 : 1);
    const values = [...haystack.matchAll(/(\d{1,4})\s*(гб|gb|тб|tb)\s*(?:ssd|накопичувач|storage)/giu)]
      .map(match => Number(match[1]) * (/^(?:тб|tb)$/i.test(match[2]) ? 1024 : 1));
    return values.some(value => value >= required);
  }

  return false;
}

function matchesTerms(text, terms, mode = 'all') {
  const haystack = String(text || '').toLocaleLowerCase('uk-UA');
  if (!terms.length) return true;
  const hits = terms.map(term => termMatches(haystack, term));
  return mode === 'any' ? hits.some(Boolean) : hits.every(Boolean);
}

function applyCriteriaToListing(listing, criteriaInput = {}) {
  const criteria = normalizeCriteria(criteriaInput);
  const text = [listing?.title, listing?.description].filter(Boolean).join(' ');
  const lowerText = text.toLocaleLowerCase('uk-UA');
  const price = toPositiveInteger(listing?.price, 0);

  if (criteria.includeTerms.length && criteria.includeTermsMode === 'all' && !matchesTerms(lowerText, criteria.includeTerms, 'all')) {
    return { matches: false, reason: 'missing_required_term', criteria };
  }
  if (criteria.includeTerms.length && criteria.includeTermsMode === 'any' && !matchesTerms(lowerText, criteria.includeTerms, 'any')) {
    return { matches: false, reason: 'missing_required_term', criteria };
  }
  if (criteria.anyTerms.length && !matchesTerms(lowerText, criteria.anyTerms, 'any')) {
    return { matches: false, reason: 'missing_any_alternative', criteria };
  }
  if (expandDefectExclusions(criteria.excludeTerms).some(term => lowerText.includes(term.toLocaleLowerCase('uk-UA')))) {
    return { matches: false, reason: 'excluded_term', criteria };
  }
  if (criteria.minPrice && (!price || price < criteria.minPrice)) {
    return { matches: false, reason: 'below_min_price', criteria };
  }
  if (criteria.maxPrice && (!price || price > criteria.maxPrice)) {
    return { matches: false, reason: 'above_max_price', criteria };
  }
  if (criteria.maxAgeMinutes > 0) {
    const ageMinutes = Number(listing?.ageMinutes);
    if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return { matches: false, reason: 'age_unknown', criteria };
    if (ageMinutes > criteria.maxAgeMinutes) return { matches: false, reason: 'too_old', criteria };
  }
  // parseOlx always supplies proxyImg, including the no-photo fallback.
  // Treat only real image URLs as photos so photosOnly does not match every card.
  const imageCandidates = [listing?.rawImgUrl, listing?.img, listing?.imageUrl, listing?.proxyImg]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
  const hasPhoto = imageCandidates.some(value =>
    !/(?:no-photo|noimage|placeholder|blank\.gif)/i.test(value)
  );
  if (criteria.photosOnly && !hasPhoto) {
    return { matches: false, reason: 'photos_required', criteria };
  }
  if (criteria.condition !== 'all') {
    // JavaScript's \b is ASCII-oriented and does not reliably delimit Cyrillic words.
    const isNew = /(?:^|[^\p{L}])(?:нове|новий|нова|нові|новый|новая|новое|новые|new)(?=$|[^\p{L}])/iu.test(text);
    const isUsed = /б\/у|(?:^|[^\p{L}])бу(?=$|[^\p{L}])|вживан|уживан|used|після використання/iu.test(text);
    if (criteria.condition === 'new' && !isNew) return { matches: false, reason: 'condition_mismatch', criteria };
    if (criteria.condition === 'used' && !isUsed) return { matches: false, reason: 'condition_mismatch', criteria };
  }

  return { matches: true, reason: null, criteria };
}

function parseNaturalLanguageQuery(input) {
  const original = String(input || '').trim().replace(/\s+/g, ' ');
  let remaining = original;
  const criteria = {};

  const parseAmount = (raw, inheritedThousands = false) => {
    const normalized = String(raw || '').trim().replace(/\s/g, '').replace(',', '.');
    const match = normalized.match(/^(\d+(?:\.\d+)?)(к|k|тисяч(?:а|і|у)?|тысяч(?:а|и)?|тис\.?|тыс\.?|грн|₴)?$/i);
    if (!match) return null;
    let amount = Number(match[1]);
    const unit = String(match[2] || '').toLocaleLowerCase('uk-UA').replace(/\.$/, '');
    if (/^(к|k|тис|тисяч|тыс|тысяч)$/.test(unit) || (inheritedThousands && amount > 0 && amount < 1000 && !unit)) amount *= 1000;
    return Number.isSafeInteger(Math.round(amount)) ? Math.round(amount) : null;
  };
  const amountPattern = '(\\d[\\d\\s.,]*(?:\\s*(?:к|k|тисяч(?:а|і|у)?|тысяч(?:а|и)?|тис\\.?|тыс\\.?|грн|₴))?)';
  const rangeRegex = new RegExp('(?:від|от|з)\\s*' + amountPattern + '\\s*(?:до|по|[-–—])\\s*' + amountPattern, 'i');
  const rangeMatch = remaining.match(rangeRegex);
  if (rangeMatch) {
    const hasThousands = /(?:к|тис|тисяч|тыс|тысяч)/i.test(rangeMatch[1] + rangeMatch[2]);
    const minPrice = parseAmount(rangeMatch[1], hasThousands);
    const maxPrice = parseAmount(rangeMatch[2], hasThousands);
    if (minPrice !== null && maxPrice !== null) {
      criteria.minPrice = Math.min(minPrice, maxPrice);
      criteria.maxPrice = Math.max(minPrice, maxPrice);
      remaining = remaining
    .replace(/^(?:я\\s+)?(?:хочу|хотів|хотіла|нужно)\\s+(?:купити|купить|придбати|найти|знайти)\\s+/iu, '')
    .replace(/^(?:я\\s+)?(?:куплю|купити|купить|придбаю|придбати|хочу|хотів|хотіла|нужно)\\s+/iu, '')
    .replace(/^(?:шукаю|ищу|знайди|найди|підбери|подбери)\\s+/iu, '')
    .replace(/[;,]+/g, ' ')
    .replace(/(?:^|\\s)(?:с|и|та|й|and|with)(?=\\s|$)/giu, ' ')
    .replace(/\\s+/g, ' ')
    .trim();

  criteria.query = remaining || original;
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
