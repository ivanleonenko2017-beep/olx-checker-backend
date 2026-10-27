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
    includeTermsMode: source.includeTermsMode === 'any' || source.include_terms_mode === 'any' ? 'any' : 'all'
  };
}

function termMatches(haystack, rawTerm) {
  const term = String(rawTerm || '').toLocaleLowerCase('uk-UA');
  if (haystack.includes(term)) return true;

  const ramRequirement = term.match(/(?:мінімум|не менше|від)?\s*(\d{1,3})\s*(?:гб|gb)\s*(?:оператив(?:ної)? пам.?яті|озу|ram)/iu);
  if (ramRequirement) {
    const values = [...haystack.matchAll(/(\d{1,3})\s*(?:гб|gb)\s*(?:оператив(?:ної)? пам.?яті|озу|ram|оперативк)/giu)]
      .map(match => Number(match[1]));
    return values.some(value => value >= Number(ramRequirement[1]));
  }

  const storageRequirement = term.match(/(?:мінімум|не менше|від)?\s*(\d{1,4})\s*(гб|gb|тб|tb)\s*(?:ssd|накопичувач|пам.?яті|storage)/iu);
  if (storageRequirement) {
    const required = Number(storageRequirement[1]) * (/^(?:тб|tb)$/i.test(storageRequirement[2]) ? 1024 : 1);
    const values = [...haystack.matchAll(/(\d{1,4})\s*(гб|gb|тб|tb)\s*(?:ssd|накопичувач|пам.?яті|storage)/giu)]
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

  if (criteria.includeTerms.length && !matchesTerms(lowerText, criteria.includeTerms, criteria.includeTermsMode)) {
    return { matches: false, reason: 'missing_required_term', criteria };
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
      remaining = remaining.replace(rangeMatch[0], ' ').trim();
    }
  }

  if (criteria.minPrice === undefined && criteria.maxPrice === undefined) {
    const pricePatterns = [
      { regex: new RegExp('(?:до|не дорожче|максимум|бюджет(?:ом)? до)\\s*' + amountPattern, 'i'), key: 'maxPrice' },
      { regex: new RegExp('(?:від|от|мінімум)\\s*' + amountPattern, 'i'), key: 'minPrice' }
    ];
    for (const pattern of pricePatterns) {
      const match = remaining.match(pattern.regex);
      if (match) {
        const amount = parseAmount(match[1]);
        if (amount !== null) criteria[pattern.key] = amount;
        remaining = remaining.replace(match[0], ' ').trim();
      }
    }
  }

  const exclusionMatch = remaining.match(/(?:^|[\s,;])(?:не показувати|не пропонувати|не пропоновать|не предлагать|не показывать|без|виключити|исключить)\s+([^.!?;]+)/i);
  if (exclusionMatch) {
    let exclusionText = exclusionMatch[1].trim();
    exclusionText = exclusionText.replace(/\s+(?<!с )(?=(?:поломан\w*|слом\w*|зламан\w*|неисправ\w*|несправ\w*|заблок\w*|розбит\w*|разбит\w*|тріснут\w*|треснут\w*|трещин\w*|скол\w*|icloud|айклауд|на запчаст\w*|не працю\w*|не работа\w*|не включ\w*))/giu, ', ');
    criteria.excludeTerms = normalizeTermList(exclusionText
      .split(/[,;]|\s+(?:та|і|й|або|и|или|and|or)\s+/iu)
      .map(term => term.trim().replace(/^(?:з|із|с|со)\s+/iu, ''))
      .filter(Boolean));
    remaining = remaining.replace(exclusionMatch[0], ' ').trim();
  }

  const newConditionMatch = remaining.match(/(?:^|[\s,;])(новий|нова|нове|нові|новый|новая|новое|новые|new)(?=$|[\s,;])/i);
  const usedConditionMatch = remaining.match(/(?:^|[\s,;])(б\/у|б\.у\.|бу|вживаний|вживана|вживане|вживані|уживаний|уживана|used|бушний)(?=$|[\s,;])/i);
  if (newConditionMatch) {
    criteria.condition = 'new';
    remaining = remaining.replace(newConditionMatch[0], ' ').trim();
  } else if (usedConditionMatch) {
    criteria.condition = 'used';
    remaining = remaining.replace(usedConditionMatch[0], ' ').trim();
  }

  const photoMatch = remaining.match(/(?:^|[\s,;])(тільки з фото|лише з фото|з фото|с фото|with photos|photos only)(?=$|[\s,;])/i);
  if (photoMatch) {
    criteria.photosOnly = true;
    remaining = remaining.replace(photoMatch[0], ' ').trim();
  }

  // Convert explicit alternatives into a structured OR condition.
  const alternativeMatch = remaining.match(/((?:nvidia\s*)?(?:rtx|gtx|rx)\s*\d{3,4}(?:\s*ti|\s*super)?|(?:iphone|айфон)\s*\d{1,2}|(?:core\s*i[3579]|ryzen\s*[3579])\s*\d{3,5})\s+(?:або|чи|или|or)\s+((?:nvidia\s*)?(?:rtx|gtx|rx)\s*\d{3,4}(?:\s*ti|\s*super)?|(?:iphone|айфон)\s*\d{1,2}|(?:core\s*i[3579]|ryzen\s*[3579])\s*\d{3,5})/iu);
  if (alternativeMatch) {
    const alternatives = [alternativeMatch[1].trim(), alternativeMatch[2].trim()]
      .map(term => term.replace(/[.!?]+$/, '').trim())
      .filter(term => term.length >= 2);
    if (alternatives.length === 2) {
      criteria.includeTerms = [...(criteria.includeTerms || []), ...alternatives];
      criteria.includeTermsMode = 'any';
      remaining = remaining.replace(alternativeMatch[0], ' ').trim();
    }
  }

  // Keep hardware requirements as explicit criteria instead of leaving them
  // buried in the broad OLX query.
  const specPatterns = [
    /(?:(?:мінімум|minimum|минимум|не менше|від)\s*)?(\d{1,3})\s*(?:гб|gb)\s*(?:оператив(?:ної|ной)? пам.?ят[іи]|озу|ram)/iu,
    /(?:(?:мінімум|minimum|минимум|не менше|від)\s*)?(\d{1,4})\s*(?:гб|gb|тб|tb)\s*(?:ssd|накопичувач|пам.?ят[іи]|storage)/iu
  ];
  for (const pattern of specPatterns) {
    const match = remaining.match(pattern);
    if (match) {
      criteria.includeTerms = [...(criteria.includeTerms || []), match[0].trim()];
      remaining = remaining.replace(match[0], ' ').trim();
    }
  }

  // Only recognize a small, explicit city dictionary; don't mistake product
  // names or arbitrary capitalized words for locations.
  const cityAliases = [
    { city: 'Київ', pattern: /(?:у|в|місто|город|г\.)\s*(?:києві|киеве|київ|киев)(?=$|[\s,.;!?])/iu },
    { city: 'Чернігів', pattern: /(?:у|в|місто|город|г\.)\s*(?:чернігові|чернигове|чернігів|чернигов)(?=$|[\s,.;!?])/iu },
    { city: 'Одеса', pattern: /(?:у|в|місто|город|г\.)\s*(?:одесі|одессе|одеса|одесса)(?=$|[\s,.;!?])/iu },
    { city: 'Львів', pattern: /(?:у|в|місто|город|г\.)\s*(?:львові|львове|львів|львов)(?=$|[\s,.;!?])/iu },
    { city: 'Харків', pattern: /(?:у|в|місто|город|г\.)\s*(?:харкові|харькове|харків|харьков)(?=$|[\s,.;!?])/iu },
    { city: 'Дніпро', pattern: /(?:у|в|місто|город|г\.)\s*(?:дніпрі|днепре|дніпро|днепр)(?=$|[\s,.;!?])/iu },
    { city: 'Запоріжжя', pattern: /(?:у|в|місто|город|г\.)\s*(?:запоріжжі|запорожье|запоріжжя)(?=$|[\s,.;!?])/iu },
    { city: 'Вінниця', pattern: /(?:у|в|місто|город|г\.)\s*(?:вінниці|виннице|вінниця|винница)(?=$|[\s,.;!?])/iu },
    { city: 'Полтава', pattern: /(?:у|в|місто|город|г\.)\s*(?:полтаві|полтаве|полтава)(?=$|[\s,.;!?])/iu },
    { city: 'Черкаси', pattern: /(?:у|в|місто|город|г\.)\s*(?:черкасах|черкаси|черкассы)(?=$|[\s,.;!?])/iu },
    { city: 'Житомир', pattern: /(?:у|в|місто|город|г\.)\s*(?:житомирі|житомире|житомир)(?=$|[\s,.;!?])/iu },
    { city: 'Івано-Франківськ', pattern: /(?:у|в|місто|город|г\.)\s*(?:івано-франківську|ивано-франковске|івано-франківськ)(?=$|[\s,.;!?])/iu },
    { city: 'Ужгород', pattern: /(?:у|в|місто|город|г\.)\s*(?:ужгороді|ужгороде|ужгород)(?=$|[\s,.;!?])/iu }
  ];
  for (const entry of cityAliases) {
    const match = remaining.match(entry.pattern);
    if (match) {
      criteria.city = entry.city;
      remaining = remaining.replace(match[0], ' ').trim();
      break;
    }
  }

  remaining = remaining
    .replace(/^(?:я\s+)?(?:хочу|хотів|хотіла|нужно)\s+(?:купити|купить|придбати|найти|знайти)\s+/iu, '')
    .replace(/^(?:шукаю|ищу|знайди|підбери|подбери)\s+/iu, '')
    .replace(/[;,]+/g, ' ')
    .replace(/\s+/g, ' ')
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
