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
      terms: ['заблокований', 'заблокирован', 'activation lock', 'блокування активації', 'активаційне блокування', 'icloud locked', 'icloud заблокований', 'icloud заблокирован']
    },
    {
      pattern: /(?:розбит|разбит|тріс|трес|трещин|тріщин|скол|бит(?:ий|ое|ый)).{0,20}(?:скло|стекл|екран|экран)?|(?:скло|стекл|екран|экран).{0,20}(?:розбит|разбит|тріс|трес|трещин|тріщин|пошкодж|поврежд)/i,
      terms: ['розбите скло', 'разбитое стекло', 'тріснуте скло', 'треснутое стекло', 'розбитий екран', 'разбитый экран', 'битий екран', 'битый экран', 'тріснутий екран', 'треснутый экран', 'пошкоджений дисплей', 'поврежденный дисплей']
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

function normalizePhoneVariant(value = '') {
  const normalized = String(value || '').toLocaleLowerCase('uk-UA').replace(/[\s._-]+/g, '');
  if (normalized === 'promax' || normalized === 'промакс') return 'pro max';
  if (normalized === 'pro' || normalized === 'про') return 'pro';
  if (normalized === 'max' || normalized === 'макс') return 'max';
  if (normalized === '+' || normalized === 'plus' || normalized === 'плюс') return 'plus';
  if (normalized === 'mini' || normalized === 'мини' || normalized === 'міні') return 'mini';
  return '';
}

function parsePhoneModelDescriptors(value = '') {
  const text = String(value || '');
  const pattern = /(?:iphone|apple(?:\s*iphone)?|айфон|іфон|ифон)\s*(\d{1,2})(?:\s*(pro[\s._-]*max|pro|max|plus|mini|про[\s._-]*макс|про|макс|плюс|міні|мини|[+]))?(?=$|[^\p{L}\p{N}])/giu;
  return [...text.matchAll(pattern)].map(match => ({
    generation: Number(match[1]),
    variant: normalizePhoneVariant(match[2] || '')
  }));
}

function parsePhoneModelDescriptor(value = '', targetGeneration = null) {
  const descriptors = parsePhoneModelDescriptors(value);
  if (!descriptors.length) return null;
  if (Number.isInteger(Number(targetGeneration))) {
    const requested = descriptors.find(item => item.generation === Number(targetGeneration));
    if (requested) return requested;
  }
  return descriptors[0];
}

function hasMultiplePhoneModels(value = '') {
  return new Set(parsePhoneModelDescriptors(value).map(item => item.generation)).size > 1;
}

function isPhoneVariantAvailable(generation, variant) {
  if (variant === 'max') return false;
  if (variant === 'mini') return [12, 13].includes(Number(generation));
  if (variant === 'plus') return ![12, 13].includes(Number(generation));
  return true;
}

function getPhoneModelLabel(value = '', targetGeneration = null) {
  const descriptor = parsePhoneModelDescriptor(value, targetGeneration);
  if (!descriptor) return '';
  if (descriptor.variant === 'pro max') return 'Pro Max';
  if (descriptor.variant === 'pro') return 'Pro';
  if (descriptor.variant === 'plus') return 'Plus';
  if (descriptor.variant === 'max') return 'Max';
  if (descriptor.variant === 'mini') return 'Mini';
  return 'Базова';
}

function isRepairPartsListing(value = '') {
  return /(?:на\s+запчастини|на\s+запчасти|під\s+ремонт|под\s+ремонт|несправн\p{L}*|не\s+працює|не\s+работает)/iu.test(String(value || ''));
}

function isAccessoryIntent(value = '') {
  const title = String(value || '').trim().toLocaleLowerCase('uk-UA');
  return /^(?:(?:хочу\s+)?(?:купити|купить|шукаю|ищу|знайди|найди)\s+)?(?:чохол|чехол|case|скло|стекло|плівка|пленка|зарядк\p{L}*|зарядн\p{L}*|кабель|адаптер|навушник\p{L}*|бампер|підставк\p{L}*|тримач|корпус|дисплей|екран|модуль|плат\p{L}*|запчаст\p{L}*|аксесуар\p{L}*|аксессуар\p{L}*|ремонт)(?=$|[^\p{L}])/iu.test(title);
}

function isNonPhoneOfferTitle(value = '') {
  const title = String(value || '').trim().toLocaleLowerCase('uk-UA');
  if (!title) return true;
  if (/^(?:(?:я\s+)?(?:куплю|купить|купити|скуплю|скупка|викуплю|викуп|покупаю|ищу|шукаю)(?=$|[^\p{L}])|(?:куплю|купить|купити|скуплю|викуплю)\s+)/iu.test(title)) return true;
  // Evaluate the head noun; an accessory mentioned after the phone is only an included extra.
  const head = title.replace(/^(?:(?:продам|продаю|продати|віддам|отдам|продаётся|продается)\s+)?(?:\d+\s+)?/iu, '');
  if (/^(?:чох\p{L}*|чех\p{L}*|case|стекл\p{L}*|скл\p{L}*|захисн\p{L}*\s+скл\p{L}*|защитн\p{L}*\s+стекл\p{L}*|плівк\p{L}*|пленк\p{L}*|кабел\p{L}*|зарядк\p{L}*|зарядн\p{L}*|адаптер\p{L}*|блок\s+(?:живлення|питания)|навушник\p{L}*|наушник\p{L}*|підставк\p{L}*|подставк\p{L}*|тримач\p{L}*|держател\p{L}*|бампер\p{L}*|корпус\p{L}*|диспле\p{L}*|екран\p{L}*|модул\p{L}*|плат\p{L}*|запчаст\p{L}*|детал\p{L}*|аксесуар\p{L}*|аксессуар\p{L}*|ремонт\p{L}*|послуг\p{L}*|услуг\p{L}*)(?=$|[^\p{L}])/iu.test(head)) return true;
  return false;
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
    includeTermsMode: source.includeTermsMode === 'any' || source.include_terms_mode === 'any' ? 'any' : 'all',
    modelTerm: typeof source.modelTerm === 'string' ? source.modelTerm.trim().replace(/\s+/g, ' ').slice(0, 60) : '',
    modelScope: ['all', 'base', 'plus', 'pro', 'pro max', 'mini'].includes(String(source.modelScope || '').toLowerCase())
      ? String(source.modelScope).toLowerCase()
      : 'exact'
  };
}

function termMatches(haystack, rawTerm, title = '') {
  const term = String(rawTerm || '').toLocaleLowerCase('uk-UA');
  if (haystack.includes(term)) return true;

  // OLX sellers use several formats for iPhone storage: "256GB", "256 GB",
  // "256ГБ", "256 ГБ", and often just "iPhone 15 256" in the title.
  // Accept a bare capacity number only when the title clearly identifies
  // an iPhone, so unrelated numbers in other listing text do not qualify.
  const phoneStorage = term.match(/^(\d{2,4})\s*(?:gb|гб)$/iu);
  if (phoneStorage) {
    const capacity = phoneStorage[1];
    const explicitCapacityPattern = new RegExp('(?:^|[^\\d])' + capacity + '\\s*(?:gb|гб)(?=$|[^\\p{L}\\p{N}])', 'iu');
    if (explicitCapacityPattern.test(haystack)) return true;

    const titleText = String(title || '').toLocaleLowerCase('uk-UA');
    const isIPhoneListing = /(?:iphone|айфон)/iu.test(titleText) ||
      /(?:iphone|айфон)/iu.test(haystack);
    const bareCapacityPattern = new RegExp(
      '(?:^|[^\\d])' + capacity + '(?!\\s*(?:mb|мб|ram|озу|оператив))(?!\\p{L})(?=$|[^\\d])',
      'iu'
    );
    // OLX cards often put the storage value in a subtitle/specification row,
    // not in the title. Search the complete card text as well as the title.
    if (isIPhoneListing && (bareCapacityPattern.test(titleText) || bareCapacityPattern.test(haystack))) return true;
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
  const text = [listing?.title, listing?.description, listing?.cardText, listing?.conditionText].filter(Boolean).join(' ');
  const lowerText = text.toLocaleLowerCase('uk-UA');
  const price = toPositiveInteger(listing?.price, 0);

  if (criteria.modelTerm) {
    const requestedModel = parsePhoneModelDescriptor(criteria.modelTerm);
    const listingModel = parsePhoneModelDescriptor(listing?.title || '', requestedModel?.generation);
    const modelScope = criteria.modelScope || 'exact';
    const sameGeneration = requestedModel && listingModel &&
      requestedModel.generation === listingModel.generation;
    const allowedVariant = listingModel && isPhoneVariantAvailable(listingModel.generation, listingModel.variant);
    const versionMatches = modelScope === 'all'
      ? Boolean(allowedVariant)
      : modelScope === 'base'
        ? listingModel?.variant === ''
        : (modelScope === 'plus' || modelScope === 'pro' || modelScope === 'pro max' || modelScope === 'mini')
          ? listingModel?.variant === modelScope && Boolean(allowedVariant)
          : listingModel?.variant === requestedModel?.variant && Boolean(allowedVariant);
    if (!sameGeneration || !versionMatches) {
      return { matches: false, reason: 'model_mismatch', criteria };
    }
    if (isNonPhoneOfferTitle(listing?.title || '')) {
      return { matches: false, reason: 'wrong_product_type', criteria };
    }
  }
  if (criteria.includeTerms.length && criteria.includeTermsMode === 'all' && !criteria.includeTerms.every(term => termMatches(lowerText, term, listing?.title))) {
    return { matches: false, reason: 'missing_required_term', criteria };
  }
  if (criteria.includeTerms.length && criteria.includeTermsMode === 'any' && !criteria.includeTerms.some(term => termMatches(lowerText, term, listing?.title))) {
    return { matches: false, reason: 'missing_required_term', criteria };
  }
  if (criteria.anyTerms.length && !matchesTerms(lowerText, criteria.anyTerms, 'any')) {
    return { matches: false, reason: 'missing_any_alternative', criteria };
  }
  const exclusionText = lowerText
    .replace(/не\s+заблокован\p{L}*/giu, ' ')
    .replace(/не\s+заблокирован\p{L}*/giu, ' ')
    .replace(/not\s+blocked/giu, ' ');
  if (expandDefectExclusions(criteria.excludeTerms).some(term => exclusionText.includes(term.toLocaleLowerCase('uk-UA')))) {
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
    const conditionText = [text, listing?.cardText, listing?.conditionText, listing?.condition]
      .filter(Boolean).join(' ').toLocaleLowerCase('uk-UA');
    const isNew = /(?:^|[^\p{L}])(?:нове|новий|нова|нові|новый|новая|новое|новые|new)(?=$|[^\p{L}])/iu.test(conditionText);
    const isUsed = /б\s*[/.]?\s*у|(?:^|[^\p{L}])бу(?=$|[^\p{L}])|вживан|уживан|used|після використання|б\s*в\s*стані/iu.test(conditionText);
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

  // Natural-language negative requirements such as "не заблокований".
  const notBlockedMatch = remaining.match(/не\s+(?:заблокован\p{L}*|заблокирован\p{L}*|в\s+блок\p{L}*)|без\s+(?:блокуван\p{L}*|блокировк\p{L}*|icloud|айклауд)/iu);
  if (notBlockedMatch) {
    criteria.excludeTerms = [...(criteria.excludeTerms || []), 'заблокований', 'заблокирован', 'activation lock', 'блокування активації', 'icloud locked', 'icloud заблокований', 'icloud заблокирован'];
    remaining = remaining.replace(notBlockedMatch[0], ' ').trim();
  }

  // General quality wording is a soft preference, not OLX's formal "used" state.
  const goodConditionMatch = remaining.match(/(?:у\s+|в\s+)?(?:норм(?:альн)?\p{L}*|хорош\p{L}*|гарн\p{L}*|відмінн\p{L}*|ідеальн\p{L}*)\s+(?:стан\p{L}*|состояни\p{L}*)|(?:стан\p{L}*|состояни\p{L}*)\s+(?:норм(?:альн)?\p{L}*|хорош\p{L}*|гарн\p{L}*|відмінн\p{L}*|ідеальн\p{L}*)/iu);
  if (goodConditionMatch) {
    criteria.excludeTerms = [...(criteria.excludeTerms || []), 'не працює', 'не работает', 'несправний', 'неисправный', 'на запчастини', 'на запчасти', 'потребує ремонту', 'требует ремонта', 'пошкоджений', 'поврежденный', 'дефектний', 'дефектный'];
    remaining = remaining.replace(goodConditionMatch[0], ' ').trim();
  }
  remaining = remaining.replace(/(^|[^\p{L}\p{N}])(?:в\s+идеале|в\s+ідеалі|ідеально)(?=$|[^\p{L}\p{N}])/giu, '$1');

  // A request for a healthy/normal battery should exclude explicitly defective
  // batteries, but must not require sellers to mention battery health in every ad.
  // This avoids turning a soft quality preference into an impossible positive match.
  const normalBatteryMatch = remaining.match(/(?:(?:з|с)\s+)?норм(?:альн)?\p{L}*\s+(?:батаре\p{L}*|акумулятор\p{L}*|battery)|(?:батаре\p{L}*|акумулятор\p{L}*|battery)\s+(?:в\s+)?нормальн\p{L}*/iu);
  if (normalBatteryMatch) {
    criteria.excludeTerms = [...(criteria.excludeTerms || []),
      'несправна батарея', 'неисправная батарея', 'батарея не держит заряд',
      'акумулятор не тримає заряд', 'не тримає заряд', 'не держит заряд',
      'battery faulty', 'battery health issue'];
    remaining = remaining.replace(normalBatteryMatch[0], ' ').trim();
  }

  // Treat an explicit storage capacity as a structured requirement rather than
  // sending it as a noisy free-text token to OLX. The listing matcher supports
  // common GB/ГБ spellings.
  const storageOnlyMatch = remaining.match(/(?:^|[\s,;])(?:(?:на\s+)?(\d{2,4})\s*(?:гб|gb|гіг(?:а|ів|и)?|гиг(?:а|ов|и)?))(?!\p{L})(?!\s*(?:оператив|озу|ram))/iu);
  // In everyday phone searches, users often write only "iPhone 15 на 256".
  // Extract that capacity as a structured filter instead of sending "256"
  // to OLX as an additional mandatory free-text search token.
  const barePhoneCapacityMatch = !storageOnlyMatch &&
    /(?:айфон|iphone|іфон|ифон|смартфон|телефон|samsung\s+galaxy)/iu.test(remaining)
    ? remaining.match(/(?:^|[\s,;])(?:на\s+)?(64|128|256|512|1024)(?!\p{L})(?!\s*(?:грн|оператив|озу|ram))/iu)
    : null;
  const capacityMatch = storageOnlyMatch || barePhoneCapacityMatch;
  if (capacityMatch) {
    const capacity = capacityMatch[1];
    criteria.includeTerms = (criteria.includeTerms || []).concat(capacity + ' ГБ');
    remaining = remaining.replace(capacityMatch[0], ' ').trim();
  }

  // "Normal screen" filters explicit damage wording only; absent descriptions
  // cannot establish the physical condition of a device.
  const normalScreenMatch = remaining.match(/(?:з\s+)?норм(?:альн)?\p{L}*\s+(?:[еэ]кран\p{L}*|диспле\p{L}*)|(?:[еэ]кран\p{L}*|диспле\p{L}*)\s+(?:в\s+)?нормальн\p{L}*|(?:с\s+)?цел(?:ый|ым|ая|ое|ые|ыми)\s+(?:[еэ]кран\p{L}*|диспле\p{L}*)|(?:[еэ]кран\p{L}*|диспле\p{L}*)\s+цел(?:ый|ым|ая|ое|ые)?/iu);
  if (normalScreenMatch) {
    criteria.excludeTerms = [...(criteria.excludeTerms || []), 'розбитий екран', 'битий екран', 'тріснутий екран', 'треснутый экран', 'разбитый экран', 'розбите скло', 'разбитое стекло', 'тріснуте скло', 'треснутое стекло', 'пошкоджений дисплей', 'поврежденный дисплей'];
    remaining = remaining.replace(normalScreenMatch[0], ' ').trim();
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

  const ageMatch = remaining.match(/(?:за останні|за последние|не старше|не старіше|опубліковані за останні|опубликованные за последние)\s*(\d{1,4})\s*(хв(?:илин(?:у|и)?)?|мин(?:ут(?:ы)?)?|год(?:ину|ини|ин)?|час(?:а|ов)?|дн(?:і|я|ей|ів)?|день|дня|дней)/iu);
  if (ageMatch) {
    const amount = Number(ageMatch[1]);
    const unit = ageMatch[2].toLocaleLowerCase('uk-UA');
    criteria.maxAgeMinutes = /^(?:хв|мин)/iu.test(unit) ? amount : /^(?:год|час)/iu.test(unit) ? amount * 60 : amount * 1440;
    remaining = remaining.replace(ageMatch[0], ' ').trim();
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
      criteria.anyTerms = [...(criteria.anyTerms || []), ...alternatives];
      remaining = remaining.replace(alternativeMatch[0], ' ').trim();
    }
  }

  // A generation without a modifier searches all released phone versions.
  // An explicit modifier remains exact; explicit negative/base wording means base only.
  const accessoryIntent = isAccessoryIntent(original);
  const phoneModel = parsePhoneModelDescriptor(remaining);
  if (phoneModel && !accessoryIntent) {
    criteria.modelTerm = 'iPhone ' + phoneModel.generation +
      (phoneModel.variant ? ' ' + phoneModel.variant.replace(/\b\w/g, char => char.toUpperCase()) : '');
    criteria.modelScope = phoneModel.variant || 'all';
    const baseOnlyMatch = original.match(/(?:без\s+(?:pro|про|plus|\+|mini|макс)?|не\s+(?:pro|про|plus|\+)|(?:базова|базовый|звичайна|звичайний|обычная|обычный)(?:\s+(?:модель|версія|версия))?)/iu);
    if (baseOnlyMatch) {
      criteria.modelScope = 'base';
      remaining = remaining.replace(baseOnlyMatch[0], ' ').trim();
    }
    const allVersionsMatch = remaining.match(/(?:будь-як\p{L}*|любой|любая|любое|будь\s+який)\s*(?:версі\p{L}*|версии|модел\p{L}*)?/iu);
    if (allVersionsMatch) {
      criteria.modelScope = 'all';
      remaining = remaining.replace(allVersionsMatch[0], ' ').trim();
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
    { city: 'Чернігів', pattern: /(?:(?:у|в|місто|город|г\.)\s*|(?:^|[,;]\s*)|\s+)(?:чернігові|чернигове|чернігів|чернигов)(?=$|[\s,.;!?])/iu },
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
    .replace(/(^|[^\p{L}\p{N}])(?:аирподсы|эйрподсы|ейрподси|air\s*pods?)(?=$|[^\p{L}\p{N}])/giu, '$1AirPods')
    .replace(/(^|[^\p{L}\p{N}])(?:самсунг|samsung)\s+(?:гелекси|галакси|галаксі|galaxy)(?=$|[^\p{L}\p{N}])/giu, '$1Samsung Galaxy')
    .replace(/(^|[^\p{L}\p{N}])(?:хороший|хорошая|хорошее|хорошие|гарний|гарна|гарне|гарні)(?=$|[^\p{L}\p{N}])/giu, '$1')
    .replace(/^(?:я\s+)?(?:хочу|хотів|хотіла|нужно)\s+(?:купити|купить|придбати|найти|знайти)\s+/iu, '')
    .replace(/^(?:я\s+)?(?:куплю|купити|купить|придбаю|придбати|хочу|хотів|хотіла|нужно)\s+/iu, '')
    .replace(/^(?:шукаю|ищу|знайди|найди|підбери|подбери)\s+/iu, '')
    .replace(/[;,]+/g, ' ')
    .replace(/(?:^|\s)(?:с|и|та|й|and|with)(?=\s|$)/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  criteria.query = remaining || original;
  return { original, criteria: normalizeCriteria(criteria), query: criteria.query };
}

function findSimilarPhoneListings(listings, criteriaInput = {}, exactItems = [], options = {}) {
  const criteria = normalizeCriteria(criteriaInput);
  const requested = parsePhoneModelDescriptor(criteria.modelTerm);
  if (!requested || requested.variant || criteria.modelScope === 'all' || options.explicitModelModifier === true) return [];

  const relaxedCriteria = { ...criteria, modelTerm: '' };
  const exactLinks = new Set((Array.isArray(exactItems) ? exactItems : [])
    .map(item => String(item?.link || '').trim()).filter(Boolean));
  const output = [];
  const seen = new Set(exactLinks);

  for (const item of (Array.isArray(listings) ? listings : [])) {
    const link = String(item?.link || '').trim();
    if (!link || seen.has(link)) continue;
    const descriptor = parsePhoneModelDescriptor(item?.title || '');
    if (!descriptor || descriptor.generation !== requested.generation || !descriptor.variant) continue;

    const match = applyCriteriaToListing(item, relaxedCriteria);
    const unverifiedStorage = !match.matches &&
      match.reason === 'missing_required_term' &&
      canUseUnverifiedStorageFallback(item, relaxedCriteria);
    if (!match.matches && !unverifiedStorage) continue;

    if (unverifiedStorage) {
      item.capacityUnverified = true;
      item.capacityVerificationNote = 'Пам’ять не підтверджена — її не вказано в картці OLX';
    }
    item.modelVersion = getPhoneModelLabel(item.title);
    item.similarModelMatch = true;
    output.push(item);
    seen.add(link);
  }
  return output;
}

function canUseUnverifiedStorageFallback(listing, criteriaInput = {}) {
  const criteria = normalizeCriteria(criteriaInput);
  const storageTerms = [...criteria.includeTerms, ...criteria.anyTerms]
    .map(term => String(term).match(/^(\d{2,4})\s*(?:гб|gb)$/iu)?.[1])
    .filter(Boolean);
  if (!storageTerms.length) return false;

  const title = String(listing?.title || '');
  if (!/(?:iphone|айфон)/iu.test(title)) return false;

  const text = [title, listing?.cardText, listing?.description, listing?.conditionText]
    .filter(Boolean).join(' ').toLocaleLowerCase('uk-UA');
  const explicitCapacities = [...text.matchAll(/(?:^|[^\d])(\d{2,4})\s*(?:гб|gb)(?=$|[^\p{L}\p{N}])/giu)]
    .map(match => match[1]);

  if (explicitCapacities.length && !explicitCapacities.some(value => storageTerms.includes(value))) {
    return false;
  }

  const relaxedCriteria = {
    ...criteria,
    includeTerms: criteria.includeTerms.filter(term => !/^\d{2,4}\s*(?:гб|gb)$/iu.test(term)),
    anyTerms: criteria.anyTerms.filter(term => !/^\d{2,4}\s*(?:гб|gb)$/iu.test(term))
  };
  return applyCriteriaToListing(listing, relaxedCriteria).matches;
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function buildPhoneMarketAnalytics(items = [], criteriaInput = {}) {
  const criteria = normalizeCriteria(criteriaInput);
  const requested = parsePhoneModelDescriptor(criteria.modelTerm);
  if (!requested) return { generation: null, memory: '', groups: [] };
  const storage = [...criteria.includeTerms, ...criteria.anyTerms]
    .map(term => String(term).match(/^(\d{2,4})\s*(?:гб|gb)$/iu)?.[1])
    .filter(Boolean);
  const memory = storage.length ? storage[0] + ' ГБ' : '';
  const availableVersions = [12, 13].includes(requested.generation)
    ? ['Базова', 'Pro', 'Pro Max', 'Mini']
    : ['Базова', 'Plus', 'Pro', 'Pro Max'];
  const selectedVersion = criteria.modelScope === 'base' ? 'Базова'
    : criteria.modelScope === 'pro max' || requested.variant === 'pro max' ? 'Pro Max'
    : criteria.modelScope === 'pro' || requested.variant === 'pro' ? 'Pro'
    : criteria.modelScope === 'plus' || requested.variant === 'plus' ? 'Plus'
    : criteria.modelScope === 'mini' || requested.variant === 'mini' ? 'Mini'
    : 'Базова';
  const selectedVersions = criteria.modelScope === 'all' ? availableVersions : [selectedVersion];
  const comparableItems = (Array.isArray(items) ? items : []).filter(item =>
    item && !isNonPhoneOfferTitle(item.title || '') &&
    !isRepairPartsListing(item.title || '') &&
    item.partsOnly !== true && item.capacityUnverified !== true &&
    Number.isFinite(Number(item.price)) && Number(item.price) > 0
  );
  const groups = selectedVersions.map(version => {
    const groupItems = comparableItems.filter(item =>
      getPhoneModelLabel(item.title || '', requested.generation) === version
    );
    const prices = groupItems.map(item => Number(item.price));
    const count = prices.length;
    const enoughData = count >= 5;
    return {
      version,
      memory,
      count,
      medianPrice: enoughData ? median(prices) : null,
      status: enoughData ? 'ok' : 'insufficient',
      statusLabel: enoughData ? '' : 'Недостатньо даних'
    };
  });
  return { generation: requested.generation, memory, groups };
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
  canUseUnverifiedStorageFallback,
  findSimilarPhoneListings,
  parsePhoneModelDescriptor,
  parsePhoneModelDescriptors,
  hasMultiplePhoneModels,
  isPhoneVariantAvailable,
  getPhoneModelLabel,
  parseNaturalLanguageQuery,
  median,
  estimateBargainPrice,
  isNonPhoneOfferTitle,
  isAccessoryIntent,
  isRepairPartsListing,
  buildPhoneMarketAnalytics
};
