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
  assert.deepEqual(parsed.criteria.excludeTerms, ['зламаний']);
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
  assert.deepEqual(excluded.criteria.excludeTerms, ['зламаний']);
  assert.equal(excluded.query, 'Ігровий ноутбук');
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
  assert.ok(parsed.criteria.excludeTerms.includes('activation lock'));
  assert.ok(parsed.criteria.excludeTerms.includes('battery faulty'));
  assert.equal(parsed.query.toLocaleLowerCase('uk-UA'), 'айфон 11');
});

test('parses common broken-glass and activation-lock exclusions', () => {
  const parsed = parseNaturalLanguageQuery('iPhone 11 за 7000 не показывать разбитое стекло, заблокирован, iCloud');
  assert.ok(parsed.criteria.excludeTerms.includes('разбитое стекло'));
  assert.ok(parsed.criteria.excludeTerms.includes('битый экран'));
  assert.ok(parsed.criteria.excludeTerms.includes('activation lock'));
  assert.ok(parsed.criteria.excludeTerms.includes('iCloud'));
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
