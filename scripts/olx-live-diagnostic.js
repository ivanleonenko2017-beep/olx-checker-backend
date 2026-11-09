const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('node:fs');
const path = require('node:path');
const { buildOlxPageUrl } = require('../olx-pagination');

const query = process.env.OLX_QUERY || 'айфон 15 256';
const baseUrl = 'https://www.olx.ua/uk/chernigov/q-' + encodeURIComponent(query) + '/';
const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7'
};

function extractCards(html) {
  const $ = cheerio.load(html);
  let cards = $('[data-cy="l-card"], [data-testid="l-card"], [data-testid*="listing-card"], [data-cy*="listing-card"]');
  if (!cards.length) cards = $('article, [role="listitem"]');
  const seen = new Set();
  const output = [];
  cards.each((_, node) => {
    const card = $(node);
    const rawLink = card.find('a[href*="/d/"], a[href*="/obyavlenie/"]').first().attr('href');
    if (!rawLink) return;
    let url;
    try { url = new URL(rawLink, 'https://www.olx.ua'); } catch { return; }
    if (!url.hostname.endsWith('olx.ua')) return;
    url.search = '';
    url.hash = '';
    const link = url.toString();
    if (seen.has(link)) return;
    seen.add(link);
    const title = card.find('h6, [data-cy="ad-card-title"], [data-testid="ad-title"], [data-testid*="title"]').first().text().trim();
    const locationDate = card.find('[data-testid="location-date"], [data-cy="location-date"], [class*="location-date"]').first().text().replace(/\s+/g, ' ').trim();
    const priceText = card.find('[data-testid="ad-price"], [data-cy="ad-price"], [class*="price"]').first().text().replace(/\s+/g, ' ').trim();
    output.push({ title, locationDate, priceText, linkPath: url.pathname });
  });
  return { cardNodes: cards.length, uniqueAds: output.length, ads: output.slice(0, 80) };
}

async function main() {
  const result = {
    query,
    baseUrl,
    pages: [],
    htmlMarkers: {}
  };
  for (const page of [1, 2]) {
    const url = page === 1 ? baseUrl : buildOlxPageUrl(baseUrl, page);
    try {
      const response = await axios.get(url, {
        headers,
        timeout: 25000,
        maxRedirects: 5,
        responseType: 'text',
        validateStatus: status => status < 500
      });
      const html = String(response.data || '');
      const $ = cheerio.load(html);
      const extracted = extractCards(html);
      result.pages.push({
        page,
        requestedUrl: url,
        finalUrl: response.request?.res?.responseUrl || url,
        status: response.status,
        contentType: response.headers['content-type'] || '',
        htmlBytes: Buffer.byteLength(html),
        title: $('title').text().trim().slice(0, 180),
        ...extracted
      });
      if (page === 1) {
        const scripts = $('script').toArray().map(node => ({
          type: $(node).attr('type') || '',
          id: $(node).attr('id') || '',
          length: $(node).html()?.length || 0
        }));
        result.htmlMarkers = {
          scriptCount: scripts.length,
          largestScripts: scripts.sort((a,b) => b.length-a.length).slice(0, 12),
          hasNextData: html.includes('__NEXT_DATA__'),
          hasApolloState: html.includes('__APOLLO_STATE__'),
          hasPreloadedState: /__INITIAL_STATE__|__PRELOADED_STATE__|window\.__STATE__/i.test(html),
          hasCaptcha: /captcha|robot check|access denied/i.test($('title').text() + ' ' + $('body').text().slice(0, 1000))
        };
      }
    } catch (error) {
      result.pages.push({
        page,
        requestedUrl: url,
        error: error.message,
        status: error.response?.status || null
      });
    }
  }
  const outputPath = path.join(process.cwd(), 'olx-live-diagnostic.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    query: result.query,
    htmlMarkers: result.htmlMarkers,
    pages: result.pages.map(page => ({
      page: page.page,
      status: page.status,
      htmlBytes: page.htmlBytes,
      cardNodes: page.cardNodes,
      uniqueAds: page.uniqueAds,
      error: page.error,
      localLocationSamples: (page.ads || []).slice(0, 25).map(ad => ({
        title: ad.title,
        locationDate: ad.locationDate,
        priceText: ad.priceText
      }))
    }))
  }, null, 2));
}

main().catch(error => {
  console.error('[OLX live diagnostic] fatal:', error.message);
  process.exitCode = 1;
});
