const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCriteria,
  applyCriteriaToListing,
  parseNaturalLanguageQuery,
  median,
  estimateBargainPrice
} = require('./smart-search');

test('normalizes advanced criteria and clamps unsafe values', () => {
  const result = normalizeCriteria({
    includeTerms: ['RTX 3060', 'rtx 3060', ' 16 GB '],
    excludeTerms: ['зламаний'],
    minPrice: 25000,
    maxPrice: 10000,
    maxDiscountPercent: 100,
    minComparableListings: 1,
    photosOnly: true
  });
  assert.deepEqual(result.includeTerms, ['RTX 3060', '16 GB']);
  assert.equal(result.maxPrice, 25000);
  assert.equal(result.maxDiscountPercent, 90);
  assert.equal(result.minComparableListings, 3);
  assert.equal(result.photosOnly, true);
});

test('rejects a listing missing a required term', () => {
  const result = applyCriteriaToListing(
    { title: 'Ігровий ноутбук, 16 GB RAM', price: 18000 },
    { includeTerms: ['RTX 3060'] }
  );
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'missing_required_term');
});

test('keeps the user-facing exclusion list concise while matching defect synonyms', () => {
  const parsed = parseNaturalLanguageQuery('iPhone 11 не предлагать неисправную батарею');
  assert.deepEqual(parsed.criteria.excludeTerms, ['неисправную батарею']);
  const result = applyCriteriaToListing(
    { title: 'iPhone 11, батарея не держит заряд', price: 7000 },
    parsed.criteria
  );
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'excluded_term');
});

test('rejects a listing containing an excluded term', () => {
  const result = applyCriteriaToListing(
    { title: 'Ноутбук RTX 3060, несправний', price: 18000 },
    { excludeTerms: ['несправний'] }
  );
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'excluded_term');
});

test('applies price range and photo requirement', () => {
  assert.equal(applyCriteriaToListing(
    { title: 'iPhone 13', price: 9000, rawImgUrl: 'https://img.example/p.jpg' },
    { minPrice: 8000, maxPrice: 10000, photosOnly: true }
  ).matches, true);
  assert.equal(applyCriteriaToListing(
    { title: 'iPhone 13', price: 9000 },
    { photosOnly: true }
  ).reason, 'photos_required');
  assert.equal(applyCriteriaToListing(
    { title: 'iPhone 13', price: 9000, proxyImg: 'https://example.com/assets/no-photo.svg' },
    { photosOnly: true }
  ).reason, 'photos_required');
  assert.equal(applyCriteriaToListing(
    { title: 'iPhone 13', price: 9000, rawImgUrl: 'https://img.example/photo.jpg', proxyImg: 'https://example.com/proxy' },
    { photosOnly: true }
  ).matches, true);
});

test('parses common natural-language budget and exclusions', () => {
  const parsed = parseNaturalLanguageQuery('Ігровий ноутбук до 20 000 грн, не показувати зламаний');
  assert.equal(parsed.criteria.maxPrice, 20000);
  assert.ok(parsed.criteria.excludeTerms.includes('зламаний'));
  assert.equal(parsed.criteria.excludeTerms.length, 1);
  assert.match(parsed.query, /Ігровий ноутбук/i);
});

test('parses Ukrainian condition and photo phrases and exclusions without commas', () => {
  const parsed = parseNaturalLanguageQuery('iPhone 13 новий тільки з фото до 20 000 грн');
  assert.equal(parsed.criteria.condition, 'new');
  assert.equal(parsed.criteria.photosOnly, true);
  assert.equal(parsed.criteria.maxPrice, 20000);
  assert.equal(parsed.query, 'iPhone 13');

  const excluded = parseNaturalLanguageQuery('Ігровий ноутбук до 20 000 грн не показувати зламаний');
  assert.equal(excluded.criteria.maxPrice, 20000);
  assert.ok(excluded.criteria.excludeTerms.includes('зламаний'));
  assert.equal(excluded.criteria.excludeTerms.length, 1);
  assert.equal(excluded.query, 'Ігровий ноутбук');
});

test('matches Cyrillic used/new condition labels without ASCII word-boundary bugs', () => {
  assert.equal(applyCriteriaToListing({ title: 'iPhone 11, б/у', price: 7000 }, { condition: 'used' }).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'iPhone 11, вживаний', price: 7000 }, { condition: 'used' }).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'iPhone 11, новий', price: 7000 }, { condition: 'new' }).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'iPhone 11', price: 7000 }, { condition: 'used' }).matches, false);
});

test('parses natural-language price ranges in thousands and used condition', () => {
  const parsed = parseNaturalLanguageQuery('Хочу купить айфон 11 от 5 до 9 тысяч б/у');
  assert.equal(parsed.criteria.minPrice, 5000);
  assert.equal(parsed.criteria.maxPrice, 9000);
  assert.equal(parsed.criteria.condition, 'used');
  assert.equal(parsed.query.toLocaleLowerCase('uk-UA'), 'айфон 11');
});

test('parses multiple Ukrainian and Russian defect exclusions', () => {
  const parsed = parseNaturalLanguageQuery('Хочу купить айфон 11 от 5 до 9 тысяч б/у не предлагать поломанные, заблокированные и с неисправной батареей');
  assert.equal(parsed.criteria.minPrice, 5000);
  assert.equal(parsed.criteria.maxPrice, 9000);
  assert.equal(parsed.criteria.condition, 'used');
  assert.ok(parsed.criteria.excludeTerms.includes('поломанные'));
  assert.ok(parsed.criteria.excludeTerms.includes('заблокированные'));
  assert.ok(parsed.criteria.excludeTerms.includes('неисправной батареей'));
  assert.equal(parsed.criteria.excludeTerms.length, 3);
  assert.equal(applyCriteriaToListing({ title: 'iPhone 11, activation lock, battery faulty', price: 7000 }, parsed.criteria).matches, false);
  assert.equal(parsed.query.toLocaleLowerCase('uk-UA'), 'айфон 11');
});

test('parses common broken-glass and activation-lock exclusions', () => {
  const parsed = parseNaturalLanguageQuery('iPhone 11 за 7000 не показывать разбитое стекло, заблокирован');
  assert.ok(parsed.criteria.excludeTerms.includes('разбитое стекло'));
  assert.equal(applyCriteriaToListing({ title: 'iPhone 11, разбитое стекло', price: 7000 }, parsed.criteria).matches, false);
  assert.equal(parsed.criteria.excludeTerms.some(term => /^icloud$/i.test(term)), false);
});

test('parses city, minimum hardware specs, and GPU alternatives from one natural-language query', () => {
  const parsed = parseNaturalLanguageQuery('Найди игровой ноутбук до 20 тысяч в Чернигове, минимум 16 ГБ оперативной памяти, RTX 3060 или RTX 4060, не показывать сломанные');
  assert.equal(parsed.criteria.maxPrice, 20000);
  assert.equal(parsed.criteria.city, 'Чернігів');
  assert.deepEqual(parsed.criteria.includeTerms, ['минимум 16 ГБ оперативной памяти']);
  assert.deepEqual(parsed.criteria.anyTerms, ['RTX 3060', 'RTX 4060']);
  assert.deepEqual(parsed.criteria.excludeTerms, ['сломанные']);
  assert.equal(parsed.query, 'игровой ноутбук');
});

test('matches minimum RAM and SSD capacities rather than exact string spelling', () => {
  const criteria = { includeTerms: ['минимум 16 ГБ оперативной памяти', '512 GB SSD'] };
  assert.equal(applyCriteriaToListing({ title: 'Ноутбук 32 GB RAM, 1 TB SSD', price: 18000 }, criteria).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'Ноутбук 8 GB RAM, 256 GB SSD', price: 12000 }, criteria).reason, 'missing_required_term');
});

test('OR alternatives accept either model but reject listings with neither', () => {
  const criteria = { anyTerms: ['RTX 3060', 'RTX 4060'] };
  assert.equal(applyCriteriaToListing({ title: 'Ноутбук RTX 4060', price: 18000 }, criteria).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'Ноутбук GTX 1650', price: 12000 }, criteria).reason, 'missing_any_alternative');
});

test('parses maximum listing age from natural language', () => {
  const parsed = parseNaturalLanguageQuery('iPhone 13 за останні 30 хвилин');
  assert.equal(parsed.criteria.maxAgeMinutes, 30);
  assert.equal(parsed.query, 'iPhone 13');
});

test('requires a reliable publication age when a maximum age is configured', () => {
  assert.equal(applyCriteriaToListing({ title: 'iPhone 13', price: 9000, ageMinutes: 12 }, { maxAgeMinutes: 30 }).matches, true);
  assert.equal(applyCriteriaToListing({ title: 'iPhone 13', price: 9000, ageMinutes: 45 }, { maxAgeMinutes: 30 }).reason, 'too_old');
  assert.equal(applyCriteriaToListing({ title: 'iPhone 13', price: 9000 }, { maxAgeMinutes: 30 }).reason, 'age_unknown');
});

test('calculates median robustly', () => {
  assert.equal(median([100, 500, 200, 300, 10000]), 300);
  assert.equal(median([100, 200, 300, 400]), 250);
  assert.equal(median([]), null);
});

test('does not claim a bargain with too few comparable listings', () => {
  const result = estimateBargainPrice(500, [700, 800, 900], { minComparableListings: 5 });
  assert.equal(result.isBargain, false);
  assert.equal(result.reliable, false);
});

test('flags a likely bargain only with enough comparable prices', () => {
  const result = estimateBargainPrice(500, [700, 800, 900, 850, 750], { minComparableListings: 5, discountPercent: 20 });
  assert.equal(result.referencePrice, 800);
  assert.equal(result.discountPercent, 38);
  assert.equal(result.isBargain, true);
  assert.equal(result.reliable, true);
});


test('parses a complete Ukrainian buying request into a usable filter', () => {
  const parsed = parseNaturalLanguageQuery('Куплю айфон 11 в Чернигове от 5 до 10к не заблокированный с норм экраном');
  assert.equal(parsed.query.toLocaleLowerCase('uk-UA'), 'айфон 11');
  assert.equal(parsed.criteria.city, 'Чернігів');
  assert.equal(parsed.criteria.minPrice, 5000);
  assert.equal(parsed.criteria.maxPrice, 10000);
  assert.ok(parsed.criteria.excludeTerms.includes('заблокований'));
  assert.ok(parsed.criteria.excludeTerms.includes('розбитий екран'));
  assert.equal(applyCriteriaToListing({
    title: 'iPhone 11 128GB, розбитий екран, iCloud locked',
    description: '',
    price: 7000
  }, parsed.criteria).matches, false);
  assert.equal(applyCriteriaToListing({
    title: 'iPhone 11 128GB',
    description: 'Стан добрий',
    price: 7000
  }, parsed.criteria).matches, true);
});

test('normal-screen request does not claim to verify listings with no damage wording', () => {
  const parsed = parseNaturalLanguageQuery('Куплю iPhone 11 з норм екраном');
  assert.equal(parsed.query, 'iPhone 11');
  assert.ok(parsed.criteria.excludeTerms.includes('битий екран'));
});


test('does not reject clean iCloud wording or a listing that explicitly says not blocked', () => {
  const parsed = parseNaturalLanguageQuery('Куплю айфон 11 не заблокированный з норм екраном');
  assert.equal(applyCriteriaToListing({
    title: 'iPhone 11, iCloud чистый, не заблокированный',
    description: 'Екран цілий, без пошкоджень',
    price: 7000
  }, parsed.criteria).matches, true);
  assert.equal(applyCriteriaToListing({
    title: 'iPhone 11, iCloud чистый',
    description: 'Телефон працює, екран цілий',
    price: 7000
  }, parsed.criteria).matches, true);
});

test('normal-screen filter does not exclude an unrelated body crack or chip', () => {
  const parsed = parseNaturalLanguageQuery('Куплю айфон 11 з норм екраном');
  assert.equal(applyCriteriaToListing({
    title: 'iPhone 11, трещина на корпусе, скол на рамке',
    description: 'Экран целый',
    price: 7000
  }, parsed.criteria).matches, true);
});

test('regression: parses Russian-language iPhone 11 query with intact screen and no activation lock', () => {
  const parsed = parseNaturalLanguageQuery('Куплю айфон 11 в Чернигове от 5 до 10к не заблокированный с норм экраном');
  assert.equal(parsed.query.toLocaleLowerCase('uk-UA'), 'айфон 11');
  assert.equal(parsed.criteria.city, 'Чернігів');
  assert.equal(parsed.criteria.minPrice, 5000);
  assert.equal(parsed.criteria.maxPrice, 10000);
  assert.ok(parsed.criteria.excludeTerms.includes('заблокований'));
  assert.ok(parsed.criteria.excludeTerms.includes('битий екран'));
  assert.equal(applyCriteriaToListing({
    title: 'iPhone 11 128GB',
    description: 'iCloud чистый, не заблокирован, экран целый',
    price: 7000
  }, parsed.criteria).matches, true);
});

test('regression: parses Ukrainian and Russian Chernihiv aliases with explicit price range', () => {
  for (const query of [
    'айфон 11 в Чернигове от 5000 до 10000',
    'iPhone 11 у Чернігові від 5000 до 10000'
  ]) {
    const parsed = parseNaturalLanguageQuery(query);
    assert.equal(parsed.criteria.city, 'Чернігів', query);
    assert.equal(parsed.criteria.minPrice, 5000, query);
    assert.equal(parsed.criteria.maxPrice, 10000, query);
    assert.match(parsed.query, /^(?:айфон|iPhone) 11$/iu, query);
  }
});

test('regression: extracts a standalone city after a comma and a maximum price', () => {
  const parsed = parseNaturalLanguageQuery('iPhone 11, Чернігів, до 10000 грн');
  assert.equal(parsed.query, 'iPhone 11');
  assert.equal(parsed.criteria.city, 'Чернігів');
  assert.equal(parsed.criteria.minPrice, 0);
  assert.equal(parsed.criteria.maxPrice, 10000);
});

