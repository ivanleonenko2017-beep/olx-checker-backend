const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { normalizeCriteria, applyCriteriaToListing, parseNaturalLanguageQuery, estimateBargainPrice, median } = require('./smart-search');

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(__dirname, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

let rawUrl = (process.env.SUPABASE_URL || '').trim();
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);
if (rawUrl.endsWith('/rest/v1')) rawUrl = rawUrl.slice(0, -8);
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);

const SUPABASE_URL = rawUrl;
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const SERVER_URL = (process.env.SERVER_URL || 'https://olx-checker-backend.onrender.com').replace(/\/$/, '');
const MONOBANK_ACQUIRING_TOKEN = (process.env.MONOBANK_ACQUIRING_TOKEN || '').trim();

const ADMIN_IDS = (process.env.ADMIN_IDS || '668277478')
  .split(',')
  .map(id => parseInt(id.trim(), 10))
  .filter(Boolean);

let supabase = null;
let supabaseAdmin = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`✅ Supabase підключено: ${SUPABASE_URL}`);
}
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  console.log('✅ Supabase server-side admin client налаштовано');
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

function verifyTelegramWebAppData(initDataRaw) {
  if (!initDataRaw || !TELEGRAM_BOT_TOKEN) return null;
  try {
    const urlParams = new URLSearchParams(initDataRaw);
    const hash = urlParams.get('hash');
    if (!hash) return null;

    urlParams.delete('hash');

    const params = [];
    for (const [key, value] of urlParams.entries()) {
      params.push(`${key}=${value}`);
    }
    params.sort();

    const dataCheckString = params.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const providedHash = Buffer.from(hash, 'hex');
    const expectedHash = Buffer.from(calculatedHash, 'hex');
    if (providedHash.length !== expectedHash.length || !crypto.timingSafeEqual(providedHash, expectedHash)) return null;

    const userStr = urlParams.get('user');
    const authDate = Number.parseInt(urlParams.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate <= 0 || authDate > now + 60 || now - authDate > 86400) {
      console.warn('[Auth Warning] Недійсні або застарілі initData');
      return null;
    }
    if (!userStr) return null;
    const user = JSON.parse(userStr);
    return user && Number.isSafeInteger(Number(user.id)) && Number(user.id) > 0 ? user : null;
  } catch (e) {
    console.error('[Auth Error] Ошибка проверки initData:', e.message);
  }
  return null;
}

async function checkIsAdmin(userId) {
  if (!userId) return false;
  const numericId = parseInt(userId, 10);
  if (ADMIN_IDS.includes(numericId)) return true;
  if (!supabase) return false;

  try {
    const { data: user } = await supabase.from('users').select('is_admin').eq('telegram_id', numericId).maybeSingle();
    return Boolean(user && user.is_admin);
  } catch (e) {
    return false;
  }
}

function userAuthMiddleware(req, res, next) {
  const initDataRaw = req.headers['x-telegram-init-data'];
  const user = verifyTelegramWebAppData(initDataRaw);

  if (!user || !user.id) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Недійсні або застарілі дані авторизації Telegram' 
    });
  }

  req.telegramUser = user;
  next();
}

async function adminAuthMiddleware(req, res, next) {
  const initDataRaw = req.headers['x-telegram-init-data'];
  const user = verifyTelegramWebAppData(initDataRaw);

  if (user && user.id && await checkIsAdmin(user.id)) {
    req.adminUser = user;
    return next();
  }

  return res.status(403).json({ 
    success: false, 
    error: 'Forbidden: Доступ заборонено (потрібні підтверджені права адміністратора)' 
  });
}

async function sendTelegramMessage(chatId, text, replyMarkup = null, useHtml = true) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[Telegram] TELEGRAM_BOT_TOKEN не налаштовано');
    return false;
  }

  const payload = { chat_id: chatId, text, disable_web_page_preview: false };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (useHtml) payload.parse_mode = 'HTML';

  try {
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload, { timeout: 8000 });
    return Boolean(response.data && response.data.ok);
  } catch (err) {
    const description = err.response?.data?.description || err.message;
    if (useHtml && /can't parse entities|unsupported start tag/i.test(description)) {
      console.warn(`[Telegram] HTML parse error for chat ${chatId}; retrying as plain text`);
      return await sendTelegramMessage(chatId, text, replyMarkup, false);
    }
    console.error(`[Telegram] sendMessage failed for chat ${chatId} (HTTP ${err.response?.status || 'network'}): ${description}`);
    return false;
  }
}

async function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const fullPhotoUrl = photoUrl.startsWith('/') ? `${SERVER_URL}${photoUrl}` : photoUrl;
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      chat_id: chatId,
      photo: fullPhotoUrl,
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }, { timeout: 8000 });
    if (response.data?.ok === true) return true;
    console.warn(`[Telegram] sendPhoto не підтвердив доставку для чату ${chatId}:`, response.data?.description || 'невідома помилка');
    return await sendTelegramMessage(chatId, caption, replyMarkup);
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn(`⚠️ Telegram Rate Limit (429) на фото для чата ${chatId}.`);
      return false;
    }
    return await sendTelegramMessage(chatId, caption, replyMarkup);
  }
}

app.get('/api/proxy-image', async (req, res) => {
  // Only proxy HTTPS images from OLX-owned domains. Never accept arbitrary URLs:
  // this endpoint is public and must not be usable to reach internal services.
  const fallback = () => res.redirect(`${SERVER_URL}/assets/no-photo.svg`);
  try {
    const imageUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!imageUrl || imageUrl.length > 2048) return fallback();

    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch {
      return fallback();
    }

    const host = parsed.hostname.toLowerCase();
    const allowedHost = host === 'olx.ua' || host.endsWith('.olx.ua') ||
      host === 'olxcdn.com' || host.endsWith('.olxcdn.com') ||
      host === 'olxstatic.com' || host.endsWith('.olxstatic.com');
    if (parsed.protocol !== 'https:' || !allowedHost || parsed.username || parsed.password) {
      return fallback();
    }

    const response = await axios.get(parsed.toString(), {
      responseType: 'arraybuffer',
      maxRedirects: 0,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://www.olx.ua/'
      },
      timeout: 5000,
      validateStatus: status => status >= 200 && status < 300
    });

    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return fallback();

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    fallback();
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function isPublishedToday(locationDate) {
  const label = String(locationDate || '').toLocaleLowerCase('uk-UA');
  return /(?:^|[\\s,·])(?:сьогодні|сегодня|today)(?=$|[\\s,·])/i.test(label);
}

function getListingAgeMinutes(locationDate) {
  const label = String(locationDate || '').toLocaleLowerCase('uk-UA');
  if (!isPublishedToday(label)) return null;
  const timeMatch = label.match(/(?:сьогодні|сегодня|today)[^\d]{0,16}(\d{1,2})[:.](\d{2})/i);
  if (!timeMatch) return null;
  const publishedHour = Number(timeMatch[1]);
  const publishedMinute = Number(timeMatch[2]);
  if (publishedHour > 23 || publishedMinute > 59) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const currentMinutes = hour * 60 + minute;
    const publishedMinutes = publishedHour * 60 + publishedMinute;
    return currentMinutes >= publishedMinutes
      ? currentMinutes - publishedMinutes
      : currentMinutes - publishedMinutes + 1440;
  } catch (_) {
    return null;
  }
}

function locationMatches(locationDate, requestedLocation) {
  const requested = String(requestedLocation || '').trim().toLocaleLowerCase('uk-UA');
  if (!requested || requested === 'всі міста' || requested === 'вся україна' || requested === 'уся україна') return true;
  const actual = String(locationDate || '').toLocaleLowerCase('uk-UA');
  // OLX cards usually expose the city in their location/date label. Match the
  // requested place only against that label; never pretend a broad search is local.
  return actual.includes(requested);
}

async function parseOlx(targetUrl, minPrice, maxPrice, query = '') {
  let response;
  try {
    response = await axios.get(targetUrl, {
      headers: HEADERS,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400
    });
    console.log(`[OLX search] Upstream response: status=${response.status}, htmlBytes=${Buffer.byteLength(String(response.data || ''), 'utf8')}`);
  } catch (requestError) {
    console.error(`[OLX search] Upstream request failed: status=${requestError.response?.status || 'no-http-status'}, code=${requestError.code || 'unknown'}`);
    throw requestError;
  }
  const html = String(response.data || '');
  const pageText = html.toLowerCase();
  // OLX may mention captcha libraries in scripts even on normal result pages.
  // Only classify explicit HTTP blocks or clear human-verification interstitial text.
  const blockPatterns = [
    /verify you are human/i,
    /access denied/i,
    /too many requests/i,
    /robot check/i,
    /підтверд.{0,20}що ви людина/i,
    /забагато запитів/i,
    /ваш доступ тимчасово обмежено/i,
    /доступ до сайту обмежено/i
  ];
  const matchedBlockPattern = blockPatterns.find(pattern => pattern.test(pageText));
  if (response.status === 403 || response.status === 429 || matchedBlockPattern) {
    console.warn(`[OLX search] Block detected: status=${response.status}, reason=${response.status === 403 || response.status === 429 ? 'http-status' : matchedBlockPattern?.source || 'unknown'}`);
    const error = new Error('OLX тимчасово обмежив доступ до пошуку. Спробуйте пізніше.');
    error.code = 'OLX_BLOCKED';
    throw error;
  }

  const $ = cheerio.load(html);
  const rawItems = [];

  const stopWords = [
    'аккумулятор', 'акумулятор', 'батарея', 'корпус', 'шлейф', 'плата', 'камера', 'динамик',
    'стекло', 'скло', 'чехол', 'чехлы', 'чохол', 'чохли', 'накладка', 'накладки', 'бампер', 'бамперы',
    'дисплей', 'экран', 'екран', 'коробка', 'кабель', 'зарядка', 'адаптер', 'ремешок', 'пленка',
    'запчасти', 'запчасть', 'разборка', 'обложка', 'обкладинка', 'накидка', 'защитное стекло',
    'защитная пленка', 'аксессуар', 'аксессуары', 'аксесуар', 'аксесуари',
    'icloud', 'lost', 'passcode', 'пароль', 'bypass', 'донор', 'скупка', 'ремонт', 'копия', 'реплика'
  ];

  // OLX periodically changes card attributes. Support both current and older
  // card markup, and only use article fallback when it contains an ad link.
  let cards = $(
    '[data-cy="l-card"], [data-testid="l-card"], ' +
    '[data-testid*="listing-card"], [data-cy*="listing-card"], ' +
    '[data-testid="listing-grid"] > div, [data-cy="listing-grid"] > div'
  ).filter((_, el) => $(el).find('a[href*="/d/"], a[href*="/obyavlenie/"]').length > 0);

  if (!cards.length) {
    cards = $('article, [role="listitem"]').filter((_, el) =>
      $(el).find('a[href*="/d/"], a[href*="/obyavlenie/"]').length > 0
    );
  }

  // Last-resort fallback for OLX markup changes: use the smallest ancestor
  // containing an ad link, a recognizable title and a price.
  if (!cards.length) {
    const seen = new Set();
    $('a[href*="/d/"], a[href*="/obyavlenie/"]').each((_, linkEl) => {
      let node = $(linkEl);
      for (let depth = 0; depth < 6 && node.length; depth++, node = node.parent()) {
        const text = node.text().replace(/\s+/g, ' ').trim();
        const hasTitle = node.find('h3, h4, h5, h6, [data-testid*="title"], [data-cy*="title"]').length > 0;
        const hasPrice = /грн|₴/.test(text);
        if (hasTitle && hasPrice && text.length < 2500) {
          const el = node.get(0);
          if (el && !seen.has(el)) {
            seen.add(el);
            cards = cards.add(node);
          }
          break;
        }
      }
    });
  }

  cards.each((index, element) => {
    if (rawItems.length >= 30) return;

    $(element).find('style, script').remove();
    const title = $(element).find('h6, h4, [data-testid="ad-title"], [data-cy="ad-title"], h3').first().text().trim();
    if (!title) return;

    const lowerTitle = title.toLowerCase();
    const queryLower = (query || '').toLowerCase();

    const hasStopWord = stopWords.some(word => lowerTitle.includes(word));
    const queryHasStopWord = stopWords.some(word => queryLower.includes(word));

    if (hasStopWord && !queryHasStopWord) return;

    const priceElement = $(element).find('[data-testid="ad-price"], [data-testid="ad-price-container"], [data-cy="ad-price"], [class*="price"]').first();
    priceElement.find('style, script').remove();
    let rawPriceText = priceElement.text().trim();

    if (rawPriceText.includes('грн')) {
      rawPriceText = rawPriceText.split('грн')[0] + ' грн';
    }

    const match = rawPriceText.match(/(\d[\d\s]*)/);
    let numericPrice = 0;
    if (match) {
      numericPrice = parseInt(match[1].replace(/\s/g, ''), 10);
    }

    if (minPrice && numericPrice < parseInt(minPrice, 10)) return;
    if (maxPrice && numericPrice > parseInt(maxPrice, 10)) return;

    const rawLink = $(element).find('a[href*="/d/"], a[href*="/obyavlenie/"], a').first().attr('href') || '';
    const link = rawLink.startsWith('http') ? rawLink : `https://www.olx.ua${rawLink}`;

    let rawImgUrl = '';
    const imgEl = $(element).find('img').first();
    const src = imgEl.attr('src') || '';
    const lazySrc = imgEl.attr('data-src') || imgEl.attr('data-lazy-src') ||
      imgEl.attr('data-original') || imgEl.attr('data-image') || '';
    const srcset = imgEl.attr('srcset') || imgEl.attr('data-srcset') || '';
    const candidates = [
      lazySrc,
      srcset && !srcset.startsWith('data:') ? srcset.split(',').pop().trim().split(/\\s+/)[0] : '',
      src,
      imgEl.attr('content') || ''
    ];

    let candidate = candidates.find(value =>
      value && !value.startsWith('data:') && !/placeholder|no-photo|noimage|blank\\.gif/i.test(value)
    ) || '';

    if (candidate) {
      candidate = candidate.replace(/\\/g, '').replace(/&amp;/g, '&');
      if (candidate.startsWith('//')) candidate = 'https:' + candidate;
      else if (candidate.startsWith('/')) candidate = 'https://www.olx.ua' + candidate;
      try {
        const imageUrl = new URL(candidate);
        if (imageUrl.protocol === 'https:' &&
            /(^|\\.)olx\.(ua|pl|bg|ro|pt|kz|uz|az|ge|md|by)$|olxcdn\.com$|olxstatic\.com$/i.test(imageUrl.hostname)) {
          rawImgUrl = imageUrl.toString();
        }
      } catch (_) {
        rawImgUrl = '';
      }
    }

    const locationDate = $(element).find('[data-testid="location-date"], [data-cy="location-date"], [class*="location"], [class*="date"]').first().text().trim();
    const descriptionCandidate = $(element).find(
      '[data-testid="ad-description"], [data-cy="ad-description"], [class*="description"], p'
    ).first().text().replace(/\s+/g, ' ').trim();
    const description = descriptionCandidate && descriptionCandidate.length > 12
      ? descriptionCandidate.slice(0, 280)
      : 'Відкрийте оголошення на OLX, щоб переглянути повний опис продавця.';

    if (title && !isNaN(numericPrice) && numericPrice > 0 && rawLink) {
      rawItems.push({
        id: 'ad_' + crypto.randomBytes(4).toString('hex'),
        title,
        price: numericPrice,
        priceText: `${numericPrice.toLocaleString('uk-UA')} грн`,
        link,
        rawImgUrl,
        proxyImg: rawImgUrl ? `${SERVER_URL}/api/proxy-image?url=${encodeURIComponent(rawImgUrl)}` : `${SERVER_URL}/assets/no-photo.svg`,
        locationDate: locationDate || 'Україна',
        description
      });
    }
  });

  const prices = rawItems.map(i => i.price).filter(price => Number.isFinite(price) && price > 0);
  // Keep the legacy API field name for compatibility, but use a robust median.
  // No market-price estimate is returned with fewer than five listings.
  const averagePrice = prices.length >= 5 ? median(prices) : 0;

  if (!rawItems.length && /olx/i.test(targetUrl) && !/search|listing|og:/.test(pageText)) {
    const error = new Error('Не вдалося розпізнати сторінку OLX. Сайт міг змінити розмітку або тимчасово обмежити доступ.');
    error.code = 'OLX_PARSE_EMPTY';
    throw error;
  }

  return { items: rawItems, averagePrice };
}


const listingDescriptionCache = new Map();
const EMPTY_CARD_DESCRIPTION = 'Відкрийте оголошення на OLX, щоб переглянути повний опис продавця.';

async function fetchListingDescription(inputUrl) {
  let parsedUrl;
  try { parsedUrl = new URL(inputUrl); } catch { return ''; }
  const host = parsedUrl.hostname.toLowerCase();
  if (parsedUrl.protocol !== 'https:' || !(host === 'olx.ua' || host.endsWith('.olx.ua')) ||
      parsedUrl.username || parsedUrl.password ||
      !(/\/d\//.test(parsedUrl.pathname) || /\/obyavlenie\//.test(parsedUrl.pathname))) return '';

  const key = parsedUrl.toString().replace(/\/$/, '');
  const cached = listingDescriptionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.description;
  if (cached) listingDescriptionCache.delete(key);

  try {
    // Throttle only real upstream requests; cache hits return immediately.
    await new Promise(resolve => setTimeout(resolve, 200));
    const response = await axios.get(key, {
      headers: { ...HEADERS, Referer: 'https://www.olx.ua/' },
      timeout: 8000,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 300
    });
    const $ = cheerio.load(String(response.data || ''));
    let description = $('[data-testid="ad-description"], [data-cy="ad-description"], [data-testid*="description"], [class*="description"]').first().text().trim();

    if (!description) {
      $('script[type="application/ld+json"]').each((_, el) => {
        if (description) return;
        try {
          const json = JSON.parse($(el).contents().text());
          const candidates = Array.isArray(json) ? json : [json];
          for (const item of candidates) {
            if (item && typeof item.description === 'string' && item.description.trim()) {
              description = item.description.trim();
              break;
            }
          }
        } catch (_) {}
      });
    }
    if (!description) description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    description = String(description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
    if (description && !/verify you are human|access denied|robot check|підтверд.{0,20}що ви людина/i.test(description)) {
      listingDescriptionCache.set(key, { description, expiresAt: Date.now() + 10 * 60 * 1000 });
      if (listingDescriptionCache.size > 500) {
        const oldestKey = listingDescriptionCache.keys().next().value;
        listingDescriptionCache.delete(oldestKey);
      }
      return description;
    }
  } catch (error) {
    console.warn('[Smart Search details] Не вдалося отримати опис:', error.response?.status || error.code || 'request-failed');
  }
  // Cache misses briefly too, so a blocked or unavailable ad is not requested
  // again for every filter scan in the next minute.
  listingDescriptionCache.set(key, { description: '', expiresAt: Date.now() + 60 * 1000 });
  return '';
}

app.get('/api/search', userAuthMiddleware, async (req, res) => {
  const startedAt = Date.now();
  const testPremiumBypass = process.env.ENABLE_TEST_PREMIUM_BYPASS === 'true';
  console.log(`[API search] Request received: queryProvided=${Boolean(req.query.query)}, categoryUrlProvided=${Boolean(req.query.categoryUrl)}, filters=${Boolean(req.query.minPrice || req.query.maxPrice || req.query.city || req.query.condition)}`);
  try {
    // Enforce trial/Premium access server-side for every search request.
    // Fail closed if the database is unavailable: do not allow a bypass.
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Перевірка доступу тимчасово недоступна. Спробуйте пізніше.' });
    }
    const userId = req.telegramUser.id;
    const isAdmin = await checkIsAdmin(userId);
    let { data: accessUser, error: accessError } = await supabase.from('users')
      .select('tariff,premium_until,trial_started_at').eq('telegram_id', userId).maybeSingle();
    if (accessError) throw accessError;

    if (!accessUser) {
      const startedAtIso = new Date().toISOString();
      const { error: createUserError } = await supabase.from('users').upsert({
        telegram_id: userId, first_name: req.telegramUser.first_name || 'User',
        is_admin: isAdmin, trial_started_at: startedAtIso
      }, { onConflict: 'telegram_id' });
      if (createUserError) throw createUserError;
      accessUser = { tariff: 'free', premium_until: null, trial_started_at: startedAtIso };
    } else if (!accessUser.trial_started_at) {
      const startedAtIso = new Date().toISOString();
      const { data: initializedUser, error: initTrialError } = await supabase.from('users')
        .update({ trial_started_at: startedAtIso }).eq('telegram_id', userId)
        .is('trial_started_at', null).select('tariff,premium_until,trial_started_at').maybeSingle();
      if (initTrialError) throw initTrialError;
      if (initializedUser) accessUser = initializedUser;
      else {
        const { data: refreshedUser, error: refreshError } = await supabase.from('users')
          .select('tariff,premium_until,trial_started_at').eq('telegram_id', userId).maybeSingle();
        if (refreshError) throw refreshError;
        accessUser = refreshedUser || accessUser;
      }
    }

    const hasActivePremium = isAdmin || (
      accessUser?.tariff === 'premium' &&
      Boolean(accessUser.premium_until) &&
      Number.isFinite(Date.parse(accessUser.premium_until)) &&
      Date.parse(accessUser.premium_until) > Date.now()
    );
    const trialStartedMs = accessUser?.trial_started_at ? Date.parse(accessUser.trial_started_at) : 0;
    const trialEndsMs = trialStartedMs > 0 ? trialStartedMs + 5 * 24 * 60 * 60 * 1000 : 0;
    const hasActiveTrial = trialEndsMs > Date.now();

    if (!hasActivePremium && !hasActiveTrial && !testPremiumBypass) {
      return res.status(403).json({
        success: false,
        error: 'Пробний період завершився. Для продовження користування потрібен Premium.',
        code: 'TRIAL_EXPIRED'
      });
    }

    const { query, categoryUrl, minPrice, maxPrice, city, condition } = req.query;
    let targetUrl = categoryUrl;

    if (!targetUrl && query) {
      const cleanQ = query.trim();
      if (cleanQ.startsWith('http://') || cleanQ.startsWith('https://')) {
        targetUrl = cleanQ;
      } else if (minPrice || maxPrice) {
        const searchMin = minPrice ? `search%5Bfilter_float_price%3Afrom%5D=${minPrice}` : '';
        const searchMax = maxPrice ? `search%5Bfilter_float_price%3Ato%5D=${maxPrice}` : '';
        const queryParams = [searchMin, searchMax].filter(Boolean).join('&');
        targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(cleanQ)}/?${queryParams}`;
      } else {
        targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(cleanQ)}/`;
      }
    }

    if (!targetUrl) return res.status(400).json({ error: 'Укажіть пошуковий запит' });

    const { items: parsedItems, averagePrice } = await parseOlx(targetUrl, minPrice, maxPrice, query);
    const requestedLocation = String(city || '').trim();
    let items = parsedItems.filter(item => locationMatches(item.locationDate, requestedLocation));
    const requestedCondition = String(condition || 'all').trim().toLowerCase();
    const conditionText = item => String(item.title || '') + ' ' + String(item.description || '');
    if (requestedCondition === 'new') {
      items = items.filter(item => /(?:^|[^\p{L}])(?:нове|новий|нова|нові|новый|новая|новое|новые|new)(?=$|[^\p{L}])/iu.test(conditionText(item)));
    } else if (requestedCondition === 'used') {
      items = items.filter(item => /б\/у|(?:^|[^\p{L}])бу(?=$|[^\p{L}])|вживан|уживан|після використання|used/iu.test(conditionText(item)));
    }
    console.log(`[API search] Completed: parsed=${parsedItems.length}, returned=${items.length}, durationMs=${Date.now() - startedAt}`);
    res.json({ success: true, count: items.length, averagePrice, items });
  } catch (error) {
    console.error(`[API search] Failed: code=${error.code || 'unknown'}, status=${error.response?.status || 'none'}, message=${String(error.message || 'unknown').slice(0, 180)}, durationMs=${Date.now() - startedAt}`);
    if (error.code === 'OLX_BLOCKED') {
      return res.status(503).json({ success: false, error: error.message });
    }
    if (error.code === 'OLX_PARSE_EMPTY') {
      return res.status(502).json({ success: false, error: error.message });
    }
    res.status(502).json({ success: false, error: 'Не вдалося отримати оголошення з OLX. Спробуйте ще раз трохи пізніше.' });
  }
});

app.get('/api/ad-details', async (req, res) => {
  try {
    const inputUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!inputUrl || inputUrl.length > 2048) return res.status(400).json({ success: false, error: 'Некоректне посилання' });
    let parsedUrl;
    try { parsedUrl = new URL(inputUrl); } catch {
      return res.status(400).json({ success: false, error: 'Некоректне посилання' });
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (parsedUrl.protocol !== 'https:' || !(host === 'olx.ua' || host.endsWith('.olx.ua')) ||
        parsedUrl.username || parsedUrl.password ||
        !(/\/d\//.test(parsedUrl.pathname) || /\/obyavlenie\//.test(parsedUrl.pathname))) {
      return res.status(400).json({ success: false, error: 'Посилання має вести на оголошення OLX' });
    }
    const response = await axios.get(parsedUrl.toString(), {
      headers: { ...HEADERS, Referer: 'https://www.olx.ua/' },
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });
    const $ = cheerio.load(String(response.data || ''));
    let description = $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('[data-testid="ad-description"]').text() ||
      $('[data-cy="ad-description"]').text() || '';
    if (!String(description).trim()) {
      $('script[type="application/ld+json"]').each((_, el) => {
        if (String(description).trim()) return;
        try {
          const json = JSON.parse($(el).contents().text());
          for (const item of (Array.isArray(json) ? json : [json])) {
            if (item && typeof item.description === 'string' && item.description.trim()) {
              description = item.description;
              break;
            }
          }
        } catch (_) {}
      });
    }
    description = String(description).replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim();
    if (description.length > 500) description = description.slice(0, 497).trimEnd() + '...';
    res.json({ success: true, description });
  } catch (err) {
    console.warn('[Ad details] Не вдалося отримати опис OLX:', err.response?.status || err.code || err.message);
    res.status(502).json({ success: false, description: '' });
  }
});

app.get('/api/user/profile', userAuthMiddleware, async (req, res) => {
  try {
    const testPremiumBypass = process.env.ENABLE_TEST_PREMIUM_BYPASS === 'true';
    const userId = req.telegramUser.id;
    const isAdmin = await checkIsAdmin(userId);
    let userData = { tariff: 'free', premium_until: null, trial_started_at: null };

    if (supabase) {
      const { data, error } = await supabase.from('users').select('*').eq('telegram_id', userId).maybeSingle();
      if (error) throw error;
      if (data) {
        userData = data;
      } else {
        const { error: upsertError } = await supabase.from('users').upsert({
          telegram_id: userId, first_name: req.telegramUser.first_name || 'User', is_admin: isAdmin,
          trial_started_at: new Date().toISOString()
        }, { onConflict: 'telegram_id' });
        if (upsertError) throw upsertError;
        userData.trial_started_at = new Date().toISOString();
      }
      // Start the one-time 5-day trial on the first Mini App profile request.
      if (!userData.trial_started_at) {
        const trialStartedAt = new Date().toISOString();
        const { data: initializedUser, error: trialInitError } = await supabase.from('users')
          .update({ trial_started_at: trialStartedAt }).eq('telegram_id', userId).is('trial_started_at', null)
          .select('*').maybeSingle();
        if (trialInitError) throw trialInitError;
        if (initializedUser) userData = initializedUser;
        else {
          const { data: refreshedUser, error: refreshError } = await supabase.from('users')
            .select('*').eq('telegram_id', userId).maybeSingle();
          if (refreshError) throw refreshError;
          if (refreshedUser) userData = refreshedUser;
        }
      }
    }

    const hasActivePremium = testPremiumBypass || isAdmin || (
      userData.tariff === 'premium' &&
      Boolean(userData.premium_until) &&
      Number.isFinite(Date.parse(userData.premium_until)) &&
      Date.parse(userData.premium_until) > Date.now()
    );
    const trialStartedMs = userData.trial_started_at ? Date.parse(userData.trial_started_at) : 0;
    const trialEndsAt = trialStartedMs > 0 ? new Date(trialStartedMs + 5 * 24 * 60 * 60 * 1000).toISOString() : null;
    const hasActiveTrial = testPremiumBypass || Boolean(trialEndsAt && Date.parse(trialEndsAt) > Date.now());
    if (isAdmin) {
      userData.tariff = 'premium';
      userData.is_admin = true;
    } else if (!hasActivePremium) {
      userData.tariff = 'free';
    }

    let totalReferrals = 0;
    if (supabase) {
      // Referral counts are backed by the optional referrals table added in the
      // included migration. Keep profile loading usable before the migration runs.
      const { count, error: referralCountError } = await supabase
        .from('referrals')
        .select('id', { count: 'exact', head: true })
        .eq('inviter_telegram_id', userId);
      if (!referralCountError) totalReferrals = count || 0;
      else if (!/does not exist|schema cache|relation .*referrals/i.test(referralCountError.message || '')) {
        console.warn('Не вдалося отримати кількість рефералів:', referralCountError.message);
      }
    }

    res.json({
      success: true,
      isAdmin,
      hasActivePremium,
      hasActiveTrial,
      trialEndsAt,
      access: { premiumPriceUah: 149 },
      paymentEnabled: process.env.PAYMENTS_ENABLED === 'true' && Boolean(MONOBANK_ACQUIRING_TOKEN),
      paymentProvider: 'monobank',
      user: userData,
      stats: { totalReferrals }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/user/filters', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    if (!supabase) return res.json({ success: true, filters: [] });

    const { data, error } = await supabase.from('filters').select('*').eq('user_id', userId);
    if (error) throw error;

    const uniqueFilters = [];
    const seenQueries = new Set();
    for (const f of (data || [])) {
      if (!seenQueries.has(f.query.toLowerCase())) {
        seenQueries.add(f.query.toLowerCase());
        uniqueFilters.push(f);
      }
    }

    res.json({ success: true, filters: uniqueFilters });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/filters', userAuthMiddleware, async (req, res) => {
  try {
    const testPremiumBypass = process.env.ENABLE_TEST_PREMIUM_BYPASS === 'true';
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Перевірка доступу тимчасово недоступна. Спробуйте пізніше.' });
    }
    const userId = req.telegramUser.id;
    const { query, minPrice, maxPrice, city, condition } = req.body;
    const criteriaInput = { ...(req.body.criteria && typeof req.body.criteria === 'object' ? req.body.criteria : {}) };
    if (condition !== undefined && condition !== null && condition !== '') criteriaInput.condition = condition;
    if (city !== undefined && city !== null && city !== '') criteriaInput.city = city;
    if (minPrice !== undefined && minPrice !== null && minPrice !== '') criteriaInput.minPrice = minPrice;
    if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') criteriaInput.maxPrice = maxPrice;
    const criteria = normalizeCriteria(criteriaInput);

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ success: false, error: 'Введіть коректний пошуковий запит' });
    }

    const cleanQuery = query.trim();

    if (supabase) {
      try {
        await supabase.from('users').upsert({ telegram_id: userId }, { onConflict: 'telegram_id' });
      } catch (uErr) {}

      const { data: existingFilters, error: filtersError } = await supabase
        .from('filters')
        .select('*')
        .eq('user_id', userId);
      if (filtersError) throw filtersError;

      const normalizedQuery = cleanQuery.trim().toLocaleLowerCase('uk-UA');
      const uniqueQueries = new Set((existingFilters || []).map(f => String(f.query || '').trim().toLocaleLowerCase('uk-UA')));
      const isDuplicate = uniqueQueries.has(normalizedQuery);
      if (isDuplicate) {
        return res.status(400).json({ success: false, error: 'Такий фільтр вже існує у вашому списку' });
      }

      const isAdmin = await checkIsAdmin(userId);
      const { data: userData, error: userError } = await supabase.from('users')
        .select('tariff,premium_until,trial_started_at').eq('telegram_id', userId).maybeSingle();
      if (userError) throw userError;
      const premiumExpiry = userData?.premium_until ? Date.parse(userData.premium_until) : 0;
      const isPremium = isAdmin || Boolean(userData && userData.tariff === 'premium' &&
        Number.isFinite(premiumExpiry) && premiumExpiry > Date.now());
      const trialStart = userData?.trial_started_at ? Date.parse(userData.trial_started_at) : 0;
      const hasActiveTrial = trialStart > 0 && Date.now() < trialStart + 5 * 24 * 60 * 60 * 1000;
      if (!isAdmin && !isPremium && !hasActiveTrial && !testPremiumBypass) {
        return res.status(403).json({ success: false, error: 'TRIAL_EXPIRED' });
      }

      const { data, error } = await supabase.from('filters').insert([{
        user_id: userId,
        query: cleanQuery,
        // Persist one canonical set of values so the worker cannot overwrite
        // parsed natural-language criteria with empty top-level form fields.
        min_price: criteria.minPrice || 0,
        max_price: criteria.maxPrice || 0,
        city: criteria.city || (city ? city.trim() : 'Всі міста'),
        condition: criteria.condition || condition || 'all',
        criteria
      }]).select();

      if (error) throw error;
      const createdFilter = data[0];

      try {
        let targetUrl = cleanQuery;
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(cleanQuery)}/`;
        }
        const { items } = await parseOlx(targetUrl, minPrice, maxPrice, cleanQuery);
        if (items && items.length > 0) {
          const initialSeen = items.map(item => ({
            filter_id: createdFilter.id,
            ad_link: item.link
          }));
          const { error: warmupInsertError } = await supabase.from('seen_ads').insert(initialSeen);
          if (warmupInsertError) console.error('[Warmup Warning] Не вдалося позначити початкові оголошення:', warmupInsertError.message);
        }
      } catch (warmupErr) {
        console.error('[Warmup Warning] Помилка первинного прогреву:', warmupErr.message);
      }

      return res.json({ success: true, filter: createdFilter });
    }
    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/parse-query', userAuthMiddleware, async (req, res) => {
  try {
    const text = typeof req.body?.query === 'string' ? req.body.query.slice(0, 500) : '';
    if (!text.trim()) return res.status(400).json({ success: false, error: 'Введіть пошуковий запит' });
    return res.json({ success: true, ...parseNaturalLanguageQuery(text) });
  } catch (err) {
    return res.status(400).json({ success: false, error: 'Не вдалося розібрати запит' });
  }
});

app.delete('/api/filters/:id', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    const filterId = req.params.id;

    if (supabase) {
      const { data: filter, error: fetchErr } = await supabase
        .from('filters')
        .select('id,user_id,query')
        .eq('id', filterId)
        .maybeSingle();

      if (fetchErr || !filter) {
        return res.status(404).json({ success: false, error: 'Фільтр не знайдено' });
      }

      if (parseInt(filter.user_id, 10) !== parseInt(userId, 10)) {
        return res.status(403).json({ success: false, error: 'Forbidden: Ви не є власником цього фільтра' });
      }

      const normalizedQuery = String(filter.query || '').trim().toLocaleLowerCase('uk-UA');
      const { data: sameFilters, error: sameError } = await supabase
        .from('filters').select('id,query').eq('user_id', userId);
      if (sameError) throw sameError;
      const duplicateIds = (sameFilters || [])
        .filter(item => String(item.query || '').trim().toLocaleLowerCase('uk-UA') === normalizedQuery)
        .map(item => item.id);
      if (duplicateIds.length) {
        const { error: seenDeleteError } = await supabase.from('seen_ads').delete().in('filter_id', duplicateIds);
        if (seenDeleteError) throw seenDeleteError;
        const { error: deleteErr } = await supabase.from('filters').delete().in('id', duplicateIds).eq('user_id', userId);
        if (deleteErr) throw deleteErr;
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/legal/terms', (req, res) => {
  res.json({
    title: "Публічна оферта та Умови використання ЗНАЙДЕНО",
    content: "Дана Оферта є офіційною пропозицією сервісу ЗНАЙДЕНО для фізичних осіб щодо надання доступу до функцій автоматичного моніторингу оголошень. Оплата послуг або використання Telegram Mini App означає повне прийняття цих умов."
  });
});

app.get('/api/legal/privacy', (req, res) => {
  res.json({
    title: "Політика конфіденційності",
    content: "Сервіс ЗНАЙДЕНО обробляє тільки публічні дані Telegram (ID, ім'я) та збережені параметри фільтрів. Платіжні дані обробляються виключно ліцензованими провайдерами (Telegram Stars)."
  });
});

app.get('/api/admin/stats', adminAuthMiddleware, async (req, res) => {
  try {
    if (!supabase) return res.json({ success: true, stats: { totalUsers: 0, totalFilters: 0, totalSeen: 0 } });
    const { count: uCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: fCount } = await supabase.from('filters').select('*', { count: 'exact', head: true });
    const { count: sCount } = await supabase.from('seen_ads').select('*', { count: 'exact', head: true });

    res.json({
      success: true,
      stats: { totalUsers: uCount || 0, totalFilters: fCount || 0, totalSeen: sCount || 0 }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/user-info', adminAuthMiddleware, async (req, res) => {
  try {
    const targetId = req.query.targetId;
    if (!targetId || !supabase) return res.status(400).json({ error: 'No targetId' });

    const { data } = await supabase.from('users').select('*').eq('telegram_id', targetId).maybeSingle();
    res.json({ success: true, user: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/grant-premium', adminAuthMiddleware, async (req, res) => {
  try {
    const { targetId, days } = req.body;
    if (!targetId || !days || !supabase) return res.status(400).json({ error: 'Bad params' });

    const now = new Date();
    now.setDate(now.getDate() + parseInt(days, 10));

    const { error: grantError } = await supabase.from('users').upsert({
      telegram_id: parseInt(targetId, 10),
      tariff: 'premium',
      premium_until: now.toISOString()
    }, { onConflict: 'telegram_id' });
    if (grantError) throw grantError;

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/diagnostics', adminAuthMiddleware, async (req, res) => {
  res.json({ 
    success: true, 
    supabaseOk: Boolean(supabase), 
    botOk: Boolean(TELEGRAM_BOT_TOKEN) 
  });
});

app.post('/api/admin/broadcast', adminAuthMiddleware, async (req, res) => {
  try {
    const messageText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!messageText) return res.status(400).json({ success: false, error: 'Текст розсилки порожній' });
    if (!supabase) return res.status(503).json({ success: false, error: 'База даних недоступна' });
    if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ success: false, error: 'Telegram Bot Token не налаштовано' });

    // Include users known from both the user registry and existing filters.
    // Filter owners may predate a successful /start upsert into users.
    const [{ data: users, error: usersError }, { data: filters, error: filtersError }] = await Promise.all([
      supabase.from('users').select('telegram_id'),
      supabase.from('filters').select('user_id')
    ]);
    if (usersError) throw usersError;
    if (filtersError) throw filtersError;

    const recipients = new Set();
    for (const user of users || []) {
      const id = String(user.telegram_id || '').trim();
      if (/^\d+$/.test(id)) recipients.add(id);
    }
    for (const filter of filters || []) {
      const id = String(filter.user_id || '').trim();
      if (/^\d+$/.test(id)) recipients.add(id);
    }

    const recipientIds = [...recipients];
    let sentCount = 0;
    let failedCount = 0;
    const failures = [];

    for (const id of recipientIds) {
      const ok = await sendTelegramMessage(id, messageText);
      if (ok) {
        sentCount++;
      } else {
        failedCount++;
        if (failures.length < 5) failures.push({ telegramId: id, reason: 'Telegram не підтвердив доставку; перевірте серверний журнал' });
      }
      await new Promise(resolve => setTimeout(resolve, 350));
    }

    res.json({
      success: true,
      sentCount,
      failedCount,
      total: recipientIds.length,
      failureSamples: failures
    });
  } catch (err) {
    console.error('[Broadcast] Не вдалося виконати розсилку:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


const MONOBANK_PREMIUM_AMOUNT = 14900;
const MONOBANK_CURRENCY_UAH = 980;

async function getMonobankInvoiceStatus(invoiceId) {
  const response = await axios.post('https://api.monobank.ua/api/merchant/invoice/status', { invoiceId }, {
    headers: { 'X-Token': MONOBANK_ACQUIRING_TOKEN, 'Accept': 'application/json' },
    timeout: 12000
  });
  return response.data || {};
}

async function activateConfirmedMonobankPayment(invoiceId, amountMinor, currencyCode) {
  if (!supabaseAdmin) throw new Error('Supabase service-role client is required for payment activation');
  const { data, error } = await supabaseAdmin.rpc('activate_monobank_premium', {
    p_invoice_id: String(invoiceId),
    p_amount_minor: Number(amountMinor),
    p_currency_code: Number(currencyCode)
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Unexpected Premium activation response');
  return row;
}

async function updateMonobankNonSuccessStatus(invoiceId, status) {
  if (!new Set(['created', 'processing', 'failure', 'expired', 'reversed']).has(status) || !supabaseAdmin) return;
  const { error } = await supabaseAdmin.from('monobank_payments')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('invoice_id', invoiceId).neq('status', 'success');
  if (error) throw error;
}

app.post('/api/payments/monobank/invoice', userAuthMiddleware, async (req, res) => {
  try {
    if (process.env.PAYMENTS_ENABLED !== 'true' || !MONOBANK_ACQUIRING_TOKEN) {
      return res.status(503).json({ success: false, code: 'MONOBANK_ACQUIRING_NOT_CONFIGURED', error: 'Оплата Monobank ще не налаштована.' });
    }
    if (!supabaseAdmin) return res.status(503).json({ success: false, error: 'Платіжна база тимчасово недоступна.' });
    const userId = Number(req.telegramUser.id);
    const { error: userError } = await supabaseAdmin.from('users').upsert({
      telegram_id: userId, first_name: req.telegramUser.first_name || 'Користувач', is_admin: false
    }, { onConflict: 'telegram_id', ignoreDuplicates: true });
    if (userError) throw userError;

    const reference = 'znaideno-premium-' + crypto.randomUUID();
    const invoiceResponse = await axios.post('https://api.monobank.ua/api/merchant/invoice/create', {
      amount: MONOBANK_PREMIUM_AMOUNT,
      ccy: MONOBANK_CURRENCY_UAH,
      merchantPaymInfo: {
        reference,
        destination: 'ЗНАЙДЕНО Premium на 30 днів',
        comment: 'Premium 30 днів, Telegram ID ' + userId,
        basketOrder: [{ name: 'ЗНАЙДЕНО Premium · 30 днів', qty: 1, sum: MONOBANK_PREMIUM_AMOUNT, total: MONOBANK_PREMIUM_AMOUNT, unit: 'послуга', code: 'ZNAIDENO-PREMIUM-30D' }]
      },
      redirectUrl: SERVER_URL + '/payment/monobank/return?reference=' + encodeURIComponent(reference),
      webHookUrl: SERVER_URL + '/api/payments/monobank/webhook',
      validity: 3600
    }, { headers: { 'X-Token': MONOBANK_ACQUIRING_TOKEN, 'Accept': 'application/json' }, timeout: 12000 });

    const invoice = invoiceResponse.data || {};
    if (typeof invoice.invoiceId !== 'string' || typeof invoice.pageUrl !== 'string' || !/^https:\/\//i.test(invoice.pageUrl)) {
      throw new Error('Monobank did not return a valid invoiceId/pageUrl');
    }
    const { error: insertError } = await supabaseAdmin.from('monobank_payments').insert({
      invoice_id: invoice.invoiceId, reference, telegram_id: userId, amount_minor: MONOBANK_PREMIUM_AMOUNT,
      currency_code: MONOBANK_CURRENCY_UAH, status: 'created', page_url: invoice.pageUrl
    });
    if (insertError) throw insertError;
    return res.json({ success: true, provider: 'monobank', invoiceId: invoice.invoiceId, pageUrl: invoice.pageUrl, amountUah: 149, currency: 'UAH', periodDays: 30 });
  } catch (error) {
    console.error('[Monobank Acquiring] Invoice creation failed:', error.response?.status || error.code || error.message);
    return res.status(502).json({ success: false, error: 'Не вдалося створити рахунок Monobank. Перевірте налаштування еквайрингу.' });
  }
});

app.get('/api/payments/monobank/status/:invoiceId', userAuthMiddleware, async (req, res) => {
  try {
    if (!MONOBANK_ACQUIRING_TOKEN || !supabaseAdmin) return res.status(503).json({ success: false, error: 'Перевірка платежу недоступна.' });
    const invoiceId = String(req.params.invoiceId || '').slice(0, 200);
    const { data: payment, error } = await supabaseAdmin.from('monobank_payments')
      .select('invoice_id,telegram_id,amount_minor,currency_code,status,premium_until')
      .eq('invoice_id', invoiceId).eq('telegram_id', Number(req.telegramUser.id)).maybeSingle();
    if (error) throw error;
    if (!payment) return res.status(404).json({ success: false, error: 'Рахунок не знайдено.' });

    if (payment.status !== 'success') {
      const remote = await getMonobankInvoiceStatus(invoiceId);
      const status = String(remote.status || '').toLowerCase();
      if (status === 'success') {
        if (Number(remote.amount) !== payment.amount_minor || Number(remote.ccy) !== payment.currency_code) {
          return res.status(409).json({ success: false, error: 'Сума або валюта платежу не збігається.' });
        }
        await activateConfirmedMonobankPayment(invoiceId, remote.amount, remote.ccy);
      } else await updateMonobankNonSuccessStatus(invoiceId, status);
    }
    const { data: refreshed, error: refreshError } = await supabaseAdmin.from('monobank_payments')
      .select('status,premium_until').eq('invoice_id', invoiceId).maybeSingle();
    if (refreshError) throw refreshError;
    return res.json({ success: true, status: refreshed?.status || payment.status, paid: refreshed?.status === 'success', premiumUntil: refreshed?.premium_until || null });
  } catch (error) {
    console.error('[Monobank Acquiring] Status check failed:', error.response?.status || error.code || error.message);
    return res.status(502).json({ success: false, error: 'Не вдалося перевірити платіж. Спробуйте пізніше.' });
  }
});

app.post('/api/payments/monobank/webhook', async (req, res) => {
  try {
    if (!MONOBANK_ACQUIRING_TOKEN || !supabaseAdmin) return res.sendStatus(503);
    const signature = req.get('x-sign') || '';
    if (!signature || !req.rawBody) return res.sendStatus(401);
    const keyResponse = await axios.get('https://api.monobank.ua/api/merchant/pubkey', {
      headers: { 'X-Token': MONOBANK_ACQUIRING_TOKEN, 'Accept': 'application/json' }, timeout: 10000
    });
    const publicKey = keyResponse.data?.key || keyResponse.data?.pubkey || keyResponse.data;
    if (typeof publicKey !== 'string' || !publicKey.includes('PUBLIC KEY')) return res.sendStatus(401);
    if (!crypto.verify('sha256', req.rawBody, publicKey, Buffer.from(signature, 'base64'))) return res.sendStatus(401);

    const event = req.body || {};
    if (typeof event.invoiceId !== 'string' || typeof event.status !== 'string') return res.sendStatus(400);
    const status = event.status.toLowerCase();
    if (status === 'success') {
      const { data: payment, error } = await supabaseAdmin.from('monobank_payments').select('amount_minor,currency_code').eq('invoice_id', event.invoiceId).maybeSingle();
      if (error) throw error;
      if (!payment || Number(event.amount) !== payment.amount_minor || Number(event.ccy) !== payment.currency_code) return res.sendStatus(409);
      await activateConfirmedMonobankPayment(event.invoiceId, event.amount, event.ccy);
    } else await updateMonobankNonSuccessStatus(event.invoiceId, status);
    return res.sendStatus(200);
  } catch (error) {
    console.error('[Monobank Acquiring] Webhook failed:', error.response?.status || error.code || error.message);
    return res.sendStatus(500);
  }
});

app.get('/payment/monobank/return', (req, res) => {
  res.type('html').send('<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ЗНАЙДЕНО — оплата</title><body style="font-family:system-ui;background:#0b0d0c;color:#f5f7f3;padding:28px;max-width:480px;margin:12vh auto;text-align:center"><h1 style="color:#34d399">ЗНАЙДЕНО</h1><h2>Дякуємо!</h2><p>Поверніться до Telegram та відкрийте ЗНАЙДЕНО — статус Premium оновиться після підтвердження платежу Monobank.</p></body></html>');
});

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update) return;

  // Telegram Stars checkout: approve only the expected digital Premium product.
  if (update.pre_checkout_query) {
    const query = update.pre_checkout_query;
    const valid = query.currency === 'XTR' && query.invoice_payload === 'olx_checker_premium_30d_v1' &&
      Number(query.total_amount) === Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 100);
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
        pre_checkout_query_id: query.id,
        ok: valid,
        ...(valid ? {} : { error_message: 'Цей рахунок недійсний. Будь ласка, створіть новий.' })
      });
    } catch (err) {
      console.error('Не вдалося підтвердити Telegram Stars checkout:', err.message);
    }
    return;
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Grant Premium only after Telegram confirms a successful Stars payment.
  if (msg.successful_payment) {
    const payment = msg.successful_payment;
    const expectedStars = Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 100);
    if (payment.currency !== 'XTR' || payment.invoice_payload !== 'olx_checker_premium_30d_v1' ||
        Number(payment.total_amount) !== expectedStars || !payment.telegram_payment_charge_id) {
      console.error('Отримано платіж із неочікуваними параметрами; Premium не нараховано.');
      await sendTelegramMessage(chatId, 'Не вдалося автоматично підтвердити платіж. Напишіть на ivanleonenko2016@gmail.com.');
      return;
    }
    if (!supabase) {
      await sendTelegramMessage(chatId, 'Платіж отримано, але тимчасово недоступна база даних. Напишіть на ivanleonenko2016@gmail.com.');
      return;
    }
    try {
      const { data: existingPayment, error: paymentReadError } = await supabase
        .from('star_payments').select('telegram_payment_charge_id')
        .eq('telegram_payment_charge_id', payment.telegram_payment_charge_id).maybeSingle();
      if (paymentReadError) throw paymentReadError;
      if (existingPayment) {
        // Recover an interrupted activation if the ledger row exists but Premium was not granted.
        const { data: existingUser, error: existingUserError } = await supabase
          .from('users').select('premium_until,tariff').eq('telegram_id', chatId).maybeSingle();
        if (existingUserError) throw existingUserError;
        const existingExpiry = existingUser && existingUser.premium_until ? Date.parse(existingUser.premium_until) : 0;
        if (!Number.isFinite(existingExpiry) || existingExpiry <= Date.now()) {
          const repairedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const { error: repairError } = await supabase.from('users').upsert({
            telegram_id: chatId,
            first_name: msg.from && msg.from.first_name ? msg.from.first_name : 'User',
            tariff: 'premium',
            premium_until: repairedUntil
          }, { onConflict: 'telegram_id' });
          if (repairError) throw repairError;
          await sendTelegramMessage(chatId, 'Знайшли незавершену активацію платежу та відновили Premium на 30 днів. Дякуємо за підтримку ЗНАЙДЕНО.');
        } else {
          await sendTelegramMessage(chatId, 'Цей платіж уже оброблено, Premium активний. Дякуємо за підтримку ЗНАЙДЕНО.');
        }
        return;
      }

      const { data: currentUser, error: userReadError } = await supabase
        .from('users').select('premium_until,tariff').eq('telegram_id', chatId).maybeSingle();
      if (userReadError) throw userReadError;
      const currentExpiry = currentUser?.premium_until ? Date.parse(currentUser.premium_until) : 0;
      const rewardBase = Number.isFinite(currentExpiry) ? Math.max(Date.now(), currentExpiry) : Date.now();
      const premiumUntil = new Date(rewardBase + 30 * 24 * 60 * 60 * 1000).toISOString();

      const { error: paymentInsertError } = await supabase.from('star_payments').insert([{
        telegram_payment_charge_id: payment.telegram_payment_charge_id,
        provider_payment_charge_id: payment.provider_payment_charge_id || null,
        telegram_id: chatId,
        currency: payment.currency,
        total_amount: payment.total_amount,
        invoice_payload: payment.invoice_payload
      }]);
      if (paymentInsertError) throw paymentInsertError;

      const { error: grantError } = await supabase.from('users').upsert({
        telegram_id: chatId,
        first_name: msg.from?.first_name || 'User',
        tariff: 'premium',
        premium_until: premiumUntil
      }, { onConflict: 'telegram_id' });
      if (grantError) throw grantError;
      await sendTelegramMessage(chatId, 'Оплату Telegram Stars підтверджено! Premium активовано на 30 днів. Дякуємо за підтримку ЗНАЙДЕНО.');
    } catch (err) {
      console.error('Помилка обробки Telegram Stars платежу:', err.message);
      await sendTelegramMessage(chatId, 'Платіж отримано, але не вдалося завершити активацію автоматично. Напишіть на ivanleonenko2016@gmail.com.');
    }
    return;
  }

  if (supabase) {
    const { error: userUpsertError } = await supabase.from('users').upsert({
      telegram_id: chatId,
      first_name: msg.from?.first_name || 'User'
    }, { onConflict: 'telegram_id' });
    if (userUpsertError) console.error('[Telegram] Не вдалося зберегти користувача для розсилок:', userUpsertError.message);
  }

  if (text.startsWith('/start')) {
    const startPayload = text.trim().split(/\s+/, 2)[1] || '';
    if (startPayload === 'buy_premium') {
      const starsPrice = Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 100);
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendInvoice`, {
          chat_id: chatId,
          title: 'ЗНАЙДЕНО Premium — 30 днів',
          description: '30 днів Premium: до 1 перевірки кожні 2 хвилини та безлімітні фільтри.',
          payload: 'olx_checker_premium_30d_v1',
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: 'Premium на 30 днів', amount: starsPrice }]
        });
      } catch (err) {
        console.error('Не вдалося створити Telegram Stars рахунок:', err.message);
        await sendTelegramMessage(chatId, 'Не вдалося створити рахунок. Спробуйте пізніше або напишіть на ivanleonenko2016@gmail.com.');
      }
      return;
    }
    // Accept one referral attribution per Telegram account; never count self-referrals.
    const referralMatch = /^ref_(\d{1,20})$/.exec(startPayload);
    if (referralMatch && (supabaseAdmin || supabase)) {
      const inviterId = Number(referralMatch[1]);
      const inviteeId = Number(chatId);
      if (Number.isSafeInteger(inviterId) && inviterId > 0 &&
          Number.isSafeInteger(inviteeId) && inviteeId > 0 && inviterId !== inviteeId) {
        const referralDb = supabaseAdmin || supabase;
        const { data: newReferral, error: referralError } = await referralDb.from('referrals').upsert({
          inviter_telegram_id: inviterId,
          invitee_telegram_id: inviteeId
        }, { onConflict: 'invitee_telegram_id', ignoreDuplicates: true }).select('id');
        if (referralError && !/does not exist|schema cache|relation .*referrals/i.test(referralError.message || '')) {
          console.warn('Не вдалося зберегти реферала:', referralError.message);
        } else if (!referralError && newReferral && newReferral.length > 0) {
          // Reward only when a new, unique referral row was actually inserted.
          // Extend an existing subscription rather than overwriting remaining days.
          const { data: inviter, error: inviterReadError } = await supabase
            .from('users').select('tariff,premium_until').eq('telegram_id', inviterId).maybeSingle();
          if (!inviterReadError && inviter) {
            const currentExpiry = inviter.premium_until ? Date.parse(inviter.premium_until) : 0;
            const rewardBase = Number.isFinite(currentExpiry) ? Math.max(Date.now(), currentExpiry) : Date.now();
            const nextExpiry = new Date(rewardBase + 1 * 24 * 60 * 60 * 1000).toISOString();
            const { error: rewardError } = await supabase.from('users').update({
              tariff: 'premium',
              premium_until: nextExpiry
            }).eq('telegram_id', inviterId);
            if (rewardError) console.warn('Не вдалося нарахувати реферальний Premium:', rewardError.message);
          } else if (inviterReadError) {
            console.warn('Не вдалося перевірити власника реферального посилання:', inviterReadError.message);
          }
        }
      }
    }

    const welcomeText = 
      `👋 <b>Ласкаво просимо до ЗНАЙДЕНО 1.0.0!</b>\n\n` +
      `⚡️ <b>Твій персональний інструмент для швидкого перекупу та вигідних покупок на OLX.</b>\n\n` +
      `🎯 <b>Що вміє бот:</b>\n` +
      `• <b>Авто-моніторинг:</b> перевіряє нові оголошення за розкладом тарифу.\n` +
      `• <b>Аналітика ринку:</b> розраховує середню ціну та підказує знижки від 20%.\n` +
      `• <b>Розумні фільтри:</b> відсіює чохли, запчастини, коробки та спам.\n\n` +
      `👑 <b>Переваги PREMIUM:</b>\n` +
      `✓ Перевірка нових товарів кожні <b>2 хвилини</b>.\n` +
      `✓ <b>Безлімітні</b> активні відстеження.\n` +
      `✓ Пріоритетне надсилання сповіщень.\n\n` +
      `👇 <i>Натисніть кнопку нижче, щоб відкрити додаток та налаштувати пошук:</i>`;

    const keyboard = {
      inline_keyboard: [[{ text: 'Відкрити ЗНАЙДЕНО', web_app: { url: SERVER_URL } }]]
    };
    await sendTelegramMessage(chatId, welcomeText, keyboard);
    return;
  }

  if (text.startsWith('/paysupport') || text.startsWith('/support')) {
    await sendTelegramMessage(chatId,
      'Підтримка платежів ЗНАЙДЕНО. Опишіть проблему та, якщо є, дату платежу. Контакт: ivanleonenko2016@gmail.com. Не надсилайте дані банківської картки чи паролі.');
    return;
  }

  if (text.startsWith('/terms')) {
    await sendTelegramMessage(chatId,
      'Умови ЗНАЙДЕНО: Premium надає доступ до додаткових функцій моніторингу на 30 днів після підтвердження платежу. Сервіс незалежний від OLX і не гарантує безперервну роботу стороннього сайту. Питання щодо платежів: ivanleonenko2016@gmail.com. Повні юридичні дані постачальника та остаточні умови потрібно опублікувати до публічного запуску.');
    return;
  }

  if (text.startsWith('/admin')) {
    const isAdmin = await checkIsAdmin(chatId);
    if (!isAdmin) {
      await sendTelegramMessage(chatId, `❌ У доступі відмовлено.`);
      return;
    }
    const keyboard = {
      inline_keyboard: [[{ text: 'Відкрити адмінпанель', web_app: { url: SERVER_URL } }]]
    };
    await sendTelegramMessage(chatId, `⚙️ <b>Панель Адміністратора</b>`, keyboard);
    return;
  }
});

let isWorkerRunning = false;
async function runBackgroundWorker() {
  if (isWorkerRunning || !supabase || !TELEGRAM_BOT_TOKEN) return;

  try {
    isWorkerRunning = true;
    const { data: filters, error: filtersError } = await supabase.from('filters').select('*');
    if (filtersError) throw filtersError;
    if (!filters || filters.length === 0) return;

    for (const filter of filters) {
      try {
        const { data: filterOwner, error: ownerError } = await supabase
          .from('users').select('tariff,premium_until,is_admin,trial_started_at').eq('telegram_id', filter.user_id).maybeSingle();
        if (ownerError) {
          console.error(`Не вдалося перевірити тариф користувача для фільтра ${filter.id}:`, ownerError.message);
          continue;
        }
        const ownerPremium = Boolean(filterOwner && (
          filterOwner.is_admin === true ||
          (filterOwner.tariff === 'premium' && filterOwner.premium_until &&
            Number.isFinite(Date.parse(filterOwner.premium_until)) && Date.parse(filterOwner.premium_until) > Date.now())
        ));
        const trialStart = filterOwner?.trial_started_at ? Date.parse(filterOwner.trial_started_at) : 0;
        const ownerTrial = trialStart > 0 && Date.now() < trialStart + 5 * 24 * 60 * 60 * 1000;
        if (!ownerPremium && !ownerTrial && filterOwner?.is_admin !== true) continue;
        const intervalMs = (ownerPremium || ownerTrial ? 2 : 15) * 60 * 1000;
        const lastCheckedAt = filter.last_checked_at ? Date.parse(filter.last_checked_at) : 0;
        if (Number.isFinite(lastCheckedAt) && lastCheckedAt > 0 && Date.now() - lastCheckedAt < intervalMs) continue;

        let targetUrl = filter.query ? filter.query.trim() : '';

        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          if (filter.min_price || filter.max_price) {
            const searchMin = filter.min_price ? `search%5Bfilter_float_price%3Afrom%5D=${filter.min_price}` : '';
            const searchMax = filter.max_price ? `search%5Bfilter_float_price%3Ato%5D=${filter.max_price}` : '';
            const queryParams = [searchMin, searchMax].filter(Boolean).join('&');
            targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(targetUrl)}/?${queryParams}`;
          } else {
            targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(targetUrl)}/`;
          }
        }

        const { items: parsedItems, averagePrice } = await parseOlx(targetUrl, filter.min_price, filter.max_price, filter.query);
        const criteria = normalizeCriteria({
          ...(filter.criteria || {}),
          minPrice: filter.min_price,
          maxPrice: filter.max_price,
          city: filter.city,
          condition: filter.condition
        });
        const requestedLocation = String(filter.city || '').trim();
        // Advanced term filters need the listing page, not just the often-incomplete
        // search card. Cache successful descriptions and short-lived misses.
        const needsFullDescription = criteria.includeTerms.length > 0 || criteria.anyTerms.length > 0 || criteria.excludeTerms.length > 0;
        if (needsFullDescription) {
          for (const item of parsedItems) {
            const fullDescription = await fetchListingDescription(item.link);
            item.detailsLoaded = Boolean(fullDescription);
            if (fullDescription) item.description = fullDescription;
          }
        }
        // Load seen links before date filtering. New notifications should be limited
        // to today's listings, but previously seen listings must remain eligible for
        // price-drop checks even after OLX stops labeling them as "today".
        const { data: knownRows, error: knownError } = await supabase
          .from('seen_ads').select('ad_link').eq('filter_id', filter.id);
        if (knownError) {
          console.error(`Не вдалося перевірити seen_ads для фільтра ${filter.id}:`, knownError.message);
          continue;
        }
        const knownLinks = new Set((knownRows || []).map(row => String(row.ad_link || '').trim().replace(/\/$/, '')));
        const items = parsedItems
          .filter(item => {
            const link = String(item.link || '').trim().replace(/\/$/, '');
            return isPublishedToday(item.locationDate) || knownLinks.has(link);
          })
          .filter(item => locationMatches(item.locationDate, requestedLocation))
          .filter(item => {
            // If the detail page could not be read, don't claim the item passed
            // explicit required/excluded-word rules using incomplete card text.
            if (needsFullDescription && !item.detailsLoaded) return false;
            return applyCriteriaToListing({
              ...item,
              ageMinutes: getListingAgeMinutes(item.locationDate)
            }, criteria).matches;
          });
        if (requestedLocation && !['всі міста', 'вся україна', 'уся україна'].includes(requestedLocation.toLocaleLowerCase('uk-UA')) && parsedItems.length > 0 && items.length === 0) {
          console.log(`[Location Filter] Для фільтра ${filter.id} не знайдено карток із локацією "${requestedLocation}" серед ${parsedItems.length} результатів OLX.`);
        }
        const { error: checkedAtError } = await supabase.from('filters')
          .update({ last_checked_at: new Date().toISOString() }).eq('id', filter.id);
        if (checkedAtError) {
          console.error(`Не вдалося оновити час перевірки фільтра ${filter.id}:`, checkedAtError.message);
        }

        if (!items || items.length === 0) continue;

        // knownLinks was loaded above so older seen listings can be checked for price drops.
        const { data: priceRows, error: priceRowsError } = await supabase
          .from('ad_price_history').select('ad_link,last_price').eq('filter_id', String(filter.id));
        // Price history is an optional feature until its Supabase migration is applied.
        // Never disable new-listing notifications just because that table is not ready.
        if (priceRowsError) {
          console.warn(`[Price History] Історія цін недоступна для фільтра ${filter.id}; звичайні сповіщення продовжуються:`, priceRowsError.message);
        }
        const previousPrices = new Map((priceRows || []).map(row => [
          String(row.ad_link || '').trim().replace(/\/$/, ''),
          Number(row.last_price)
        ]));
        for (const item of items) {
          const canonicalLink = String(item.link || '').trim().replace(/\/$/, '');
          if (!canonicalLink) continue;
          const previousPrice = previousPrices.get(canonicalLink);
          const isPreviouslySeen = knownLinks.has(canonicalLink);
          const hasPriceDrop = isPreviouslySeen && Number.isFinite(previousPrice) && previousPrice > Number(item.price) && Number(item.price) > 0;
          if (isPreviouslySeen && !hasPriceDrop) {
            // Keep the latest observed price as the baseline even after increases;
            // otherwise a later drop could be compared with a stale historical value.
            if (Number(item.price) > 0 && previousPrice !== Number(item.price)) {
              const { error: baselineError } = await supabase.from('ad_price_history').upsert({
                filter_id: String(filter.id), ad_link: canonicalLink, last_price: Number(item.price), updated_at: new Date().toISOString()
              }, { onConflict: 'filter_id,ad_link' });
              if (!baselineError) previousPrices.set(canonicalLink, Number(item.price));
              else console.error('[Price History] Не вдалося оновити базову ціну:', baselineError.message);
            }
            continue;
          }

          // Compare only listings that pass the same product/condition/location
          // rules. Budget and age limits are excluded from market comparables so
          // they do not artificially push the reference median down.
          const comparableCriteria = {
            ...criteria,
            minPrice: 0,
            maxPrice: 0,
            maxAgeMinutes: 0,
            bargainHunter: false
          };
          const comparablePrices = parsedItems
            .filter(other => String(other.link || '').trim().replace(/\/$/, '') !== canonicalLink)
            .filter(other => locationMatches(other.locationDate, requestedLocation))
            .filter(other => !needsFullDescription || other.detailsLoaded)
            .filter(other => applyCriteriaToListing(other, comparableCriteria).matches)
            .map(other => Number(other.price))
            .filter(price => Number.isFinite(price) && price > 0);
          const bargain = estimateBargainPrice(item.price, comparablePrices, {
            minComparableListings: criteria.bargainHunter ? criteria.minComparableListings : 5,
            discountPercent: criteria.bargainHunter ? criteria.maxDiscountPercent : 15
          });
          const isCheap = bargain.isBargain;
          const discount = isCheap ? (bargain.discountPercent ?? 0) : 0;

          const notificationText = 
            (hasPriceDrop
              ? `📉 <b>Ціна знизилася для оголошення у фільтрі “${filter.query}”</b>\n\n<b>Було:</b> ${previousPrice.toLocaleString('uk-UA')} грн → <b>Стало:</b> ${Number(item.price).toLocaleString('uk-UA')} грн\n\n`
              : `🔎 <b>Знайдено нове оголошення для фільтра “${filter.query}”</b>\n\n`) +
            `📌 <b>${item.title}</b>\n` +
            `💰 <b>Ціна:</b> ${item.priceText} ${isCheap ? `🔥 (Нижче медіани на ${discount}%)` : ''}\n` +
            (isCheap && bargain.reliable
              ? `📊 <b>Медіана аналогів:</b> ${Number(bargain.referencePrice).toLocaleString('uk-UA')} грн • ${bargain.comparableCount} оголошень\n`
              : '') +
            `📍 <b>Місто:</b> ${item.locationDate}\n\n` +
            `<a href="${item.link}">👉 Відкрити оголошення на OLX</a>`;

          const keyboard = {
            inline_keyboard: [
              [{ text: '👉 Переглянути оголошення', url: item.link }],
              [{ text: '🚀 Відкрити ЗНАЙДЕНО', web_app: { url: SERVER_URL } }]
            ]
          };

          const photoToSend = item.rawImgUrl
            ? `${SERVER_URL}/api/proxy-image?url=${encodeURIComponent(item.rawImgUrl)}`
            : `${SERVER_URL}/assets/no-photo.svg`;
          
          const delivered = await sendTelegramPhoto(filter.user_id, photoToSend, notificationText, keyboard);
          if (delivered) {
            // Mark as seen only after Telegram confirms delivery; otherwise the
            // next scan can retry instead of silently losing the notification.
            const { data: inserted, error: insertError } = await supabase
              .from('seen_ads')
              .insert([{ filter_id: filter.id, ad_link: canonicalLink }])
              .select('ad_link');
            if (insertError || !inserted || inserted.length === 0) {
              if (insertError && !/duplicate key|unique constraint/i.test(insertError.message || '')) {
                console.error(`Не вдалося зберегти доставлене оголошення для фільтра ${filter.id}:`, insertError.message);
              }
            }
            // A price-drop alert is for an already-seen ad, so inserting seen_ads
            // normally hits the unique key. Update the price snapshot after every
            // confirmed delivery, not only after a new seen_ads row was inserted.
            knownLinks.add(canonicalLink);
            if (Number(item.price) > 0) {
              const { error: historyError } = await supabase.from('ad_price_history').upsert({
                filter_id: String(filter.id),
                ad_link: canonicalLink,
                last_price: Number(item.price),
                updated_at: new Date().toISOString()
              }, { onConflict: 'filter_id,ad_link' });
              if (historyError) console.error('[Price History] Не вдалося оновити ціну:', historyError.message);
              else previousPrices.set(canonicalLink, Number(item.price));
            }
          } else {
            console.warn(`[Notifications] Не доставлено оголошення для фільтра ${filter.id}; буде повторна спроба під час наступного сканування.`);
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch (fErr) {
        console.error(`Помилка воркера для фільтра ${filter.id}:`, fErr.message);
      }
    }
  } catch (err) {
    console.error('Помилка воркера:', err.message);
  } finally {
    isWorkerRunning = false;
  }
}

const ENABLE_BACKGROUND_WORKER = (process.env.ENABLE_BACKGROUND_WORKER || 'true').toLowerCase() !== 'false';
if (ENABLE_BACKGROUND_WORKER) {
  setInterval(runBackgroundWorker, 60000);
  console.log('Background worker enabled');
} else {
  console.log('Background worker disabled by configuration');
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'znaideno-smart-search',
    databaseConfigured: Boolean(supabase),
    adminDatabaseConfigured: Boolean(supabaseAdmin),
    backgroundWorkerEnabled: ENABLE_BACKGROUND_WORKER,
    webhookRegistrationEnabled: (process.env.REGISTER_TELEGRAM_WEBHOOK || 'true').toLowerCase() !== 'false'
  });
});

async function registerWebhook() {
  if ((process.env.REGISTER_TELEGRAM_WEBHOOK || 'true').toLowerCase() === 'false') {
    console.log('Telegram webhook registration disabled by configuration');
    return;
  }
  if (!TELEGRAM_BOT_TOKEN || !SERVER_URL) return;
  try {
    const targetWebhookUrl = `${SERVER_URL}/telegram-webhook`;
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(targetWebhookUrl)}`);
    console.log(`✅ Telegram Webhook встановлено: ${targetWebhookUrl}`);
  } catch (err) {
    console.error('Помилка встановлення Webhook:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await registerWebhook();
});