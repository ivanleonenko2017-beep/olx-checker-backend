function buildOlxPageUrl(inputUrl, page) {
  const pageNumber = Number(page);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError('OLX page number must be a positive integer');
  }

  const url = new URL(inputUrl);
  if (pageNumber === 1) url.searchParams.delete('page');
  else url.searchParams.set('page', String(pageNumber));
  return url.toString();
}

function canonicalAdUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().toLocaleLowerCase('en-US');
  } catch {
    return String(inputUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

function shouldStopAfterNoLocalPage(hasSeenLocalPage, localCountOnPage) {
  return hasSeenLocalPage === true && Number(localCountOnPage) === 0;
}

function mergeUniqueOlxItems(pages, maxItems = 600) {
  const output = [];
  const seen = new Set();
  for (const pageItems of (Array.isArray(pages) ? pages : [])) {
    for (const item of (Array.isArray(pageItems) ? pageItems : [])) {
      const key = canonicalAdUrl(item?.link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(item);
      if (output.length >= maxItems) return output;
    }
  }
  return output;
}

module.exports = { buildOlxPageUrl, canonicalAdUrl, mergeUniqueOlxItems, shouldStopAfterNoLocalPage };
