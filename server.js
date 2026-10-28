const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { normalizeCriteria, applyCriteriaToListing, parseNaturalLanguageQuery, estimateBargainPrice, median } = require('./smart-search');
const { deriveAccess, canCreateFilter, TRIAL_DAYS, PREMIUM_PRICE_UAH } = require('./access-policy');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = new Set([
      (process.env.SERVER_URL || 'https://olx-checker-backend.onrender.com').replace(/\/$/, ''),
      ...(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
    ]);
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  credentials: false
}));
app.use(express.json({ limit: '100kb' }));

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
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
// All database access originates on this server. Prefer the service-role key when
// configured so RLS can be enabled without granting public API roles data access.
const SUPABASE_KEY = (SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
// All instances registering the same bot webhook must use the same secret.
// Prefer an explicit Render secret; derive a stable fallback from the bot token rather
// than generating a different random secret on each instance/restart.
const TELEGRAM_WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET ||
  (TELEGRAM_BOT_TOKEN
    ? crypto.createHmac('sha256', TELEGRAM_BOT_TOKEN).update('znaideno-telegram-webhook-v1').digest('hex')
    : '')).trim();
const SERVER_URL = (process.env.SERVER_URL || 'https://olx-checker-backend.onrender.com').replace(/\/$/, '');

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

async function consumeDailySearchQuota(userId, dailyLimit) {
  if (!supabaseAdmin) throw new Error('Service-role database client is required for atomic search quota checks');
  const { data, error } = await supabaseAdmin.rpc('consume_daily_search', {
    p_telegram_id: Number(userId),
    p_daily_limit: Number(dailyLimit)
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== 'boolean') throw new Error('Unexpected search quota response');
  return { allowed: row.allowed, used: Number(row.used_count || 0), remaining: Number(row.remaining_count || 0) };
}

async function getDailySearchUsage(userId) {
  if (!supabaseAdmin) return { used: 0, date: null };
  const { data, error } = await supabaseAdmin.from('user_daily_usage')
    .select('search_count,usage_date').eq('telegram_id', Number(userId)).maybeSingle();
  if (error) throw error;
  if (!data || data.usage_date !== new Date().toISOString().slice(0, 10)) return { used: 0, date: null };
  return { used: Number(data.search_count || 0), date: data.usage_date };
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
  const fallback = () => res.redirect(`${SERVER_URL}/assets/no-photo.png`);
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
  return /(?:^|[\s,·])(?:сьогодні|сегодня|today)(?=$|[\s,·])/i.test(label);
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

function normalizeLocationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .toLocaleLowerCase('uk-UA')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function getOlxCitySlug(city) {
  const normalized = normalizeLocationText(city);
  const knownSlugs = {
    'чернигов': 'chernigov',
    'чернігів': 'chernigov',
    'київ': 'kiev',
    'киев': 'kiev',
    'львів': 'lvov',
    'львов': 'lvov',
    'харків': 'kharkov',
    'харьков': 'kharkov',
    'одеса': 'odessa',
    'одесса': 'odessa',
    'дніпро': 'dnepr',
    'днепр': 'dnepr',
    'запоріжжя': 'zaporozhye',
    'запорожье': 'zaporozhye',
    'полтава': 'poltava',
    'сумі': 'sumy',
    'суми': 'sumy',
    'рівне': 'rovno',
    'ровно': 'rovno',
    'житомир': 'zhitomir',
    'чернівці': 'chernovtsy',
    'черновцы': 'chernovtsy'
  };
  if (knownSlugs[normalized]) return knownSlugs[normalized];
  const transliteration = {
    а:'a', б:'b', в:'v', г:'g', ґ:'g', д:'d', е:'e', є:'ye', ж:'zh', з:'z',
    и:'y', і:'i', ї:'yi', й:'y', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p',
    р:'r', с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh',
    щ:'shch', ь:'', ю:'yu', я:'ya'
  };
  return normalized.split('').map(char => transliteration[char] ?? char).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function locationMatches(locationDate, requestedLocation) {
  const requestedRaw = String(requestedLocation || '').trim();
  const requested = normalizeLocationText(requestedRaw);
  if (!requested || ['всі міста', 'вся україна', 'уся україна'].some(value => normalizeLocationText(value) === requested)) return true;
  const actual = normalizeLocationText(locationDate);
  if (actual.includes(requested)) return true;
  const aliases = {
    'чернігів': ['чернигов', 'chernigov'],
    'чернигов': ['чернігів', 'chernigov'],
    'київ': ['киев', 'kiev'],
    'киев': ['київ', 'kiev'],
    'львів': ['львов', 'lvov'],
    'львов': ['львів', 'lvov'],
    'харків': ['харьков', 'kharkov'],
    'харьков': ['харків', 'kharkov'],
    'одеса': ['одесса', 'odessa'],
    'одесса': ['одеса', 'odessa'],
    'дніпро': ['днепр', 'dnepr'],
    'днепр': ['дніпро', 'dnepr']
  };
  return (aliases[requestedRaw.toLocaleLowerCase('uk-UA')] || aliases[requested] || [])
    .some(alias => actual.includes(normalizeLocationText(alias)));
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
      srcset && !srcset.startsWith('data:') ? srcset.split(',').pop().trim().split(/\s+/)[0] : '',
      src,
      imgEl.attr('content') || ''
    ];

    let candidate = candidates.find(value =>
      value && !value.startsWith('data:') && !/placeholder|no-photo|noimage|blank\.gif/i.test(value)
    ) || '';

    if (candidate) {
      candidate = candidate.replace(/\\/g, '').replace(/&amp;/g, '&');
      if (candidate.startsWith('//')) candidate = 'https:' + candidate;
      else if (candidate.startsWith('/')) candidate = 'https://www.olx.ua' + candidate;
      try {
        const imageUrl = new URL(candidate);
        if (imageUrl.protocol === 'https:' &&
            /(^|\.)olx\.(ua|pl|bg|ro|pt|kz|uz|az|ge|md|by)$|olxcdn\.com$|olxstatic\.com$/i.test(imageUrl.hostname)) {
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
    let conditionMarker = '';

    // OLX often exposes condition as structured metadata rather than in the
    // seller's description. Preserve it as matching context for Smart Search.
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        const candidates = Array.isArray(json) ? json : [json];
        for (const item of candidates) {
          if (!item || typeof item !== 'object') continue;
          const rawCondition = item.itemCondition ?? item.condition ??
            (Array.isArray(item.additionalProperty)
              ? item.additionalProperty.find(prop => /condition|стан/i.test(String(prop?.name || '')))?.value
              : '');
          const conditionValue = typeof rawCondition === 'string'
            ? rawCondition
            : String(rawCondition?.name || rawCondition?.['@id'] || '');
          if (/UsedCondition|pre.?owned|вживан|уживан|б\/?у/i.test(conditionValue)) {
            conditionMarker = ' Стан оголошення: вживаний.';
          } else if (/NewCondition|brand.?new|новий|нова|нове/i.test(conditionValue)) {
            conditionMarker = ' Стан оголошення: новий.';
          }
          if (!description && typeof item.description === 'string' && item.description.trim()) {
            description = item.description.trim();
          }
        }
      } catch (_) {}
    });
    const visibleCondition = $('[data-testid*="condition"], [data-cy*="condition"], [class*="condition"]').text().trim();
    if (!conditionMarker && /вживан|уживан|б\/?у|used|pre.?owned/i.test(visibleCondition)) {
      conditionMarker = ' Стан оголошення: вживаний.';
    } else if (!conditionMarker && /новий|нова|нове|new/i.test(visibleCondition)) {
      conditionMarker = ' Стан оголошення: новий.';
    }
    if (!description) description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    description = String(description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
    if (description && conditionMarker) description = (description + conditionMarker).slice(0, 5000);
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

    let access = deriveAccess(accessUser || {}, isAdmin);
    if (testPremiumBypass) access = { ...access, plan: 'premium', hasActivePremium: true, hasActiveTrial: false, searchLimit: Infinity };
    let searchQuota = { used: 0, remaining: access.searchLimit };
    if (!isAdmin && !testPremiumBypass) {
      const quota = await consumeDailySearchQuota(userId, access.searchLimit);
      if (!quota.allowed) {
        return res.status(429).json({
          success: false,
          code: 'DAILY_SEARCH_LIMIT',
          error: access.plan === 'free'
            ? 'Ви використали 5 безкоштовних пошуків на сьогодні. Ліміт оновиться опівночі.'
            : 'Ви використали денний ліміт пошуку. Спробуйте завтра.',
          plan: access.plan,
          searchesUsedToday: quota.used,
          searchesLimitToday: access.searchLimit,
          searchesRemainingToday: 0
        });
      }
      searchQuota = { used: quota.used, remaining: quota.remaining };
    }

    const { query: rawQuery, categoryUrl, minPrice: rawMinPrice, maxPrice: rawMaxPrice, city: rawCity, condition: rawCondition, smart: smartMode } = req.query;
    const parsedNaturalQuery = smartMode === '1' && typeof rawQuery === 'string' &&
      !/^https?:\/\//i.test(rawQuery.trim())
      ? parseNaturalLanguageQuery(rawQuery)
      : null;
    const query = parsedNaturalQuery?.query || rawQuery;
    const parsedCriteria = parsedNaturalQuery?.criteria || {};
    const criteria = normalizeCriteria({
      ...parsedCriteria,
      minPrice: rawMinPrice !== undefined ? rawMinPrice : parsedCriteria.minPrice,
      maxPrice: rawMaxPrice !== undefined ? rawMaxPrice : parsedCriteria.maxPrice,
      city: rawCity || parsedCriteria.city,
      condition: rawCondition || parsedCriteria.condition
    });
    const minPrice = rawMinPrice !== undefined && rawMinPrice !== '' ? rawMinPrice : criteria.minPrice || '';
    const maxPrice = rawMaxPrice !== undefined && rawMaxPrice !== '' ? rawMaxPrice : criteria.maxPrice || '';
    const city = rawCity || criteria.city || '';
    const condition = rawCondition || criteria.condition || 'all';
    let targetUrl = categoryUrl;

    if (!targetUrl && query) {
      const cleanQ = query.trim();
      if (cleanQ.startsWith('http://') || cleanQ.startsWith('https://')) {
        targetUrl = cleanQ;
      } else {
        // Smart Search must ask OLX for the selected city before applying
        // client-side location matching; otherwise the first national page
        // can contain no listings from the requested city at all.
        const citySlug = parsedNaturalQuery && city ? getOlxCitySlug(city) : '';
        const searchPath = citySlug
          ? `https://www.olx.ua/uk/${citySlug}/q-${encodeURIComponent(cleanQ)}/`
          : `https://www.olx.ua/uk/list/q-${encodeURIComponent(cleanQ)}/`;
        const searchMin = minPrice ? `search%5Bfilter_float_price%3Afrom%5D=${minPrice}` : '';
        const searchMax = maxPrice ? `search%5Bfilter_float_price%3Ato%5D=${maxPrice}` : '';
        const queryParams = [searchMin, searchMax].filter(Boolean).join('&');
        targetUrl = queryParams ? `${searchPath}?${queryParams}` : searchPath;
      }
    }

    if (!targetUrl) return res.status(400).json({ error: 'Укажіть пошуковий запит' });

    const { items: parsedItems, averagePrice } = await parseOlx(targetUrl, minPrice, maxPrice, query);
    const requestedLocation = String(city || '').trim();
    const locationItems = parsedItems.filter(item => locationMatches(item.locationDate, requestedLocation));
    const requestedCondition = String(condition || 'all').trim().toLowerCase();
    if (requestedCondition !== 'all') criteria.condition = requestedCondition;
    const rejectionReasons = {};
    const items = locationItems.filter(item => {
      const result = applyCriteriaToListing(item, criteria);
      if (!result.matches) rejectionReasons[result.reason] = (rejectionReasons[result.reason] || 0) + 1;
      return result.matches;
    });
    console.log(`[API search] Completed: parsed=${parsedItems.length}, cityMatched=${locationItems.length}, returned=${items.length}, rejected=${JSON.stringify(rejectionReasons)}, city=${JSON.stringify(requestedLocation)}, url=${targetUrl}, smart=${Boolean(parsedNaturalQuery)}, durationMs=${Date.now() - startedAt}`);
    res.json({
      success: true,
      count: items.length,
      averagePrice,
      items,
      plan: access.plan,
      searchesUsedToday: searchQuota.used,
      searchesLimitToday: Number.isFinite(access.searchLimit) ? access.searchLimit : null,
      searchesRemainingToday: Number.isFinite(searchQuota.remaining) ? searchQuota.remaining : null,
      ...(parsedNaturalQuery ? { parsedQuery: parsedNaturalQuery.query, criteria: parsedCriteria } : {})
    });
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
    // Prefer listing-specific seller text and structured listing metadata over
    // generic site-wide meta descriptions, which otherwise look identical on every ad.
    let description =
      $('[data-testid="ad-description"]').text() ||
      $('[data-cy="ad-description"]').text() ||
      $('[data-testid*="ad-description"]').text() ||
      $('[data-cy*="description"]').text() || '';
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
    if (!String(description).trim()) {
      description = $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') || '';
    }
    description = String(description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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

    let access = deriveAccess(userData, isAdmin);
    if (testPremiumBypass) access = { ...access, plan: 'premium', hasActivePremium: true, hasActiveTrial: false };
    const hasActivePremium = access.hasActivePremium || testPremiumBypass;
    const hasActiveTrial = access.hasActiveTrial;
    const trialEndsAt = access.trialEndsAt;
    if (isAdmin) {
      userData.tariff = 'premium';
      userData.is_admin = true;
    } else if (!hasActivePremium && userData.tariff === 'premium' && userData.premium_until &&
      Date.parse(userData.premium_until) <= Date.now()) {
      userData.tariff = 'free';
    }

    let totalReferrals = 0;
    if (supabaseAdmin || supabase) {
      // Use the server-side database client because the referrals table is intentionally not public.
      const { count, error: referralCountError } = await (supabaseAdmin || supabase)
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
      access: {
        plan: access.plan,
        filterLimit: Number.isFinite(access.filterLimit) ? access.filterLimit : null,
        searchLimit: Number.isFinite(access.searchLimit) ? access.searchLimit : null,
        checkIntervalMinutes: access.checkIntervalMinutes,
        premiumPriceUah: PREMIUM_PRICE_UAH
      },
      searchesUsedToday: (await getDailySearchUsage(userId)).used,
      // Card acquiring stays disabled until a dedicated compliant acquiring setup is configured.
      paymentEnabled: false,
      paymentProvider: 'manual-jar-and-stars',
      telegramStarsEnabled: process.env.PAYMENTS_ENABLED === 'true' &&
        (process.env.REGISTER_TELEGRAM_WEBHOOK || 'true').toLowerCase() !== 'false' &&
        Boolean(TELEGRAM_BOT_TOKEN && supabase && supabaseAdmin) &&
        Number.isSafeInteger(Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE)) &&
        Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE) > 0,
      telegramStarsPrice: Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 0),
      monobankJarUrl: '', // Digital goods in Telegram Mini Apps are sold only via Telegram Stars.
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
        await supabase.from('users').upsert({
          telegram_id: userId,
          trial_started_at: new Date().toISOString()
        }, { onConflict: 'telegram_id', ignoreDuplicates: true });
        await supabase.from('users').update({ trial_started_at: new Date().toISOString() })
          .eq('telegram_id', userId).is('trial_started_at', null);
      } catch (uErr) {
        console.warn('[Filter access] Не вдалося ініціалізувати пробний період:', uErr.message);
      }

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
      let access = deriveAccess(userData || {}, isAdmin);
      if (testPremiumBypass) access = { ...access, plan: 'premium', filterLimit: 20 };
      if (!canCreateFilter(access, (existingFilters || []).length)) {
        return res.status(403).json({
          success: false,
          error: 'LIMIT_EXCEEDED',
          code: 'LIMIT_EXCEEDED',
          plan: access.plan,
          filterLimit: access.filterLimit,
          message: access.plan === 'free'
            ? 'На безкоштовному тарифі можна мати 1 активний фільтр. Видаліть старий або оформіть Premium.'
            : access.plan === 'trial'
              ? 'Під час пробного періоду можна мати до 3 активних фільтрів.'
              : 'На Premium можна мати до 20 активних фільтрів.'
        });
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

app.get('/api/legal/terms', (_req, res) => {
  res.json({
    title: 'Умови використання ЗНАЙДЕНО — передрелізна редакція',
    status: 'draft',
    paymentsEnabled: process.env.PAYMENTS_ENABLED === 'true',
    content: [
      'ЗНАЙДЕНО надає програмні функції пошуку й моніторингу оголошень, збереження фільтрів та сповіщень.',
      'Пробний період триває 4 дні; після нього доступний безкоштовний тариф з обмеженнями. Цифровий Premium у Mini App має ціну 180 ⭐ за 30 днів, одноразово, без автоматичного поновлення; придбання можливе лише коли платежі ввімкнені та Telegram успішно створює рахунок.',
      'Реальні платежі вважаються доступними лише якщо платіжний сценарій увімкнений сервером і рахунок успішно створюється. Premium активується лише після підтвердження успішного платежу.',
      'Сервіс не гарантує виявлення кожного оголошення, точність даних сторонніх джерел або безперервну доступність.',
      'Ця передрелізна редакція не замінює остаточну публічну оферту. До комерційного запуску потрібно опублікувати перевірені реквізити постачальника, умови поновлення/скасування, повернення та права споживача.',
      'Питання: @esqide.'
    ].join('\n')
  });
});

app.get('/api/legal/privacy', (_req, res) => {
  res.json({
    title: 'Політика конфіденційності ЗНАЙДЕНО — передрелізна редакція',
    status: 'draft',
    content: [
      'Залежно від використаних функцій сервіс обробляє Telegram ID та доступні поля профілю, пошукові запити й фільтри, тариф і строк доступу, ідентифікатори платіжних транзакцій Telegram Stars, ідентифікатори оголошень для запобігання дублюванню, звернення до підтримки та технічні журнали.',
      'Дані використовуються для входу, збереження фільтрів, пошуку, сповіщень, обліку підписки/платежів, підтримки, діагностики та захисту від зловживань.',
      'Інфраструктура поточної версії включає Telegram, Render і Supabase. Доступність сторонніх платіжних методів залежить від фактично підключеної інтеграції. Сервіс не призначений для збору даних платіжної картки.',
      'Строки зберігання, порядок видалення, правові підстави, реквізити володільця даних і міжнародні передавання мають бути підтверджені до публічного запуску. Не вважайте цей передрелізний текст остаточною політикою.',
      'Запити щодо даних: @esqide.'
    ].join('\n')
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

app.post('/api/payments/jar/claim', userAuthMiddleware, async (req, res) => {
  return res.status(410).json({
    success: false,
    code: 'MONOBANK_IN_APP_DISABLED',
    error: 'Оплата цифрового Premium усередині Telegram доступна лише в Telegram Stars.'
  });
});

app.post('/api/payments/stars/invoice-link', userAuthMiddleware, async (req, res) => {
  try {
    const starsPrice = Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 0);
    if (process.env.PAYMENTS_ENABLED !== 'true' ||
        (process.env.REGISTER_TELEGRAM_WEBHOOK || 'true').toLowerCase() === 'false' ||
        !TELEGRAM_BOT_TOKEN || !supabase || !supabaseAdmin ||
        !Number.isSafeInteger(starsPrice) || starsPrice < 1) {
      return res.status(503).json({
        success: false,
        code: 'PAYMENTS_DISABLED',
        error: 'Оплата ще не активована. Зараз триває тестування; доступ до Premium можна буде придбати після фінального налаштування.'
      });
    }
    if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ success: false, error: 'Платіжний бот тимчасово недоступний.' });
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
      title: 'ЗНАЙДЕНО Premium — 30 днів',
      description: 'Premium: до 20 активних фільтрів, перевірка кожні 2 хвилини та розширені можливості пошуку.',
      payload: 'znaideno_premium_monthly_v1',
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'ЗНАЙДЕНО Premium · 30 днів', amount: starsPrice }],
    }, { timeout: 10000 });
    if (!response.data?.ok || typeof response.data.result !== 'string') {
      throw new Error(response.data?.description || 'Telegram не повернув платіжне посилання');
    }
    res.json({ success: true, invoiceLink: response.data.result, starsPrice, priceUah: PREMIUM_PRICE_UAH });
  } catch (error) {
    console.error('[Stars] Не вдалося створити invoice link:', error.response?.data?.description || error.message);
    res.status(502).json({ success: false, error: 'Не вдалося створити рахунок. Спробуйте пізніше.' });
  }
});

app.post('/telegram-webhook', async (req, res) => {
  const receivedWebhookSecret = req.get('x-telegram-bot-api-secret-token') || '';
  const receivedSecretBuffer = Buffer.from(receivedWebhookSecret);
  const expectedSecretBuffer = Buffer.from(TELEGRAM_WEBHOOK_SECRET);
  if (!TELEGRAM_WEBHOOK_SECRET || receivedSecretBuffer.length !== expectedSecretBuffer.length ||
      !crypto.timingSafeEqual(receivedSecretBuffer, expectedSecretBuffer)) {
    return res.sendStatus(401);
  }
  try {
  const update = req.body;
  if (!update) return;

  // Telegram Stars checkout: approve only the expected digital Premium product.
  if (update.pre_checkout_query) {
    const query = update.pre_checkout_query;
    const configuredStarsPrice = Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 0);
    const valid = process.env.PAYMENTS_ENABLED === 'true' &&
      Number.isSafeInteger(configuredStarsPrice) && configuredStarsPrice > 0 &&
      query.currency === 'XTR' && query.invoice_payload === 'znaideno_premium_monthly_v1' &&
      Number(query.total_amount) === configuredStarsPrice;
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
    const expectedStars = Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 0);
    if (payment.currency !== 'XTR' || payment.invoice_payload !== 'znaideno_premium_monthly_v1' ||
        Number(payment.total_amount) !== expectedStars || !payment.telegram_payment_charge_id) {
      console.error('Отримано платіж із неочікуваними параметрами; Premium не нараховано.');
      await sendTelegramMessage(chatId, 'Не вдалося автоматично підтвердити платіж. Напишіть на @esqide.');
      return;
    }
    const paymentDb = supabaseAdmin || supabase;
    if (!paymentDb) {
      await sendTelegramMessage(chatId, 'Платіж отримано, але тимчасово недоступна база даних. Напишіть на @esqide.');
      return;
    }
    try {
      const { data: existingPayment, error: paymentReadError } = await paymentDb
        .from('star_payments')
        .select('telegram_payment_charge_id,activation_status,premium_until,is_recurring,is_first_recurring')
        .eq('telegram_payment_charge_id', payment.telegram_payment_charge_id).maybeSingle();
      if (paymentReadError) throw paymentReadError;

      let premiumUntil;
      if (existingPayment) {
        if (existingPayment.activation_status === 'active' && existingPayment.premium_until) {
          await sendTelegramMessage(chatId, 'Цей платіж уже оброблено. Premium залишається активним до вказаної дати.');
          return;
        }
        premiumUntil = existingPayment.premium_until;
        if (!premiumUntil) {
          const { data: currentUser, error: userReadError } = await paymentDb
            .from('users').select('premium_until').eq('telegram_id', chatId).maybeSingle();
          if (userReadError) throw userReadError;
          const currentExpiry = currentUser?.premium_until ? Date.parse(currentUser.premium_until) : 0;
          const rewardBase = Number.isFinite(currentExpiry) ? Math.max(Date.now(), currentExpiry) : Date.now();
          premiumUntil = new Date(rewardBase + 30 * 24 * 60 * 60 * 1000).toISOString();
          const { error: saveExpiryError } = await paymentDb.from('star_payments')
            .update({ premium_until: premiumUntil }).eq('telegram_payment_charge_id', payment.telegram_payment_charge_id);
          if (saveExpiryError) throw saveExpiryError;
        }
      } else {
        const { data: currentUser, error: userReadError } = await paymentDb
          .from('users').select('premium_until').eq('telegram_id', chatId).maybeSingle();
        if (userReadError) throw userReadError;
        const currentExpiry = currentUser?.premium_until ? Date.parse(currentUser.premium_until) : 0;
        const rewardBase = Number.isFinite(currentExpiry) ? Math.max(Date.now(), currentExpiry) : Date.now();
        premiumUntil = new Date(rewardBase + 30 * 24 * 60 * 60 * 1000).toISOString();
        const { error: paymentInsertError } = await paymentDb.from('star_payments').insert([{
          telegram_payment_charge_id: payment.telegram_payment_charge_id,
          provider_payment_charge_id: payment.provider_payment_charge_id || null,
          telegram_id: chatId,
          currency: payment.currency,
          total_amount: payment.total_amount,
          invoice_payload: payment.invoice_payload,
          activation_status: 'pending',
          premium_until: premiumUntil,
          is_recurring: payment.is_recurring === true,
          is_first_recurring: payment.is_first_recurring === true
        }]);
        if (paymentInsertError) throw paymentInsertError;
      }

      const { error: grantError } = await paymentDb.from('users').upsert({
        telegram_id: chatId,
        first_name: msg.from?.first_name || 'User',
        tariff: 'premium',
        premium_until: premiumUntil
      }, { onConflict: 'telegram_id' });
      if (grantError) throw grantError;
      const { error: activateError } = await paymentDb.from('star_payments').update({
        activation_status: 'active',
        premium_until: premiumUntil,
        is_recurring: payment.is_recurring === true || existingPayment?.is_recurring === true,
        is_first_recurring: payment.is_first_recurring === true || existingPayment?.is_first_recurring === true
      }).eq('telegram_payment_charge_id', payment.telegram_payment_charge_id);
      if (activateError) throw activateError;
      await sendTelegramMessage(chatId, 'Оплату Telegram Stars підтверджено! Premium активовано на 30 днів. Дякуємо за підтримку ЗНАЙДЕНО.');
    } catch (err) {
      console.error('Помилка обробки Telegram Stars платежу:', err.message);
      await sendTelegramMessage(chatId, 'Платіж отримано, але не вдалося завершити активацію автоматично. Напишіть на @esqide.');
    }
    return;
  }

  let isNewTelegramUser = false;
  if (supabaseAdmin || supabase) {
    const userDb = supabaseAdmin || supabase;
    try {
      const { data: previousUser, error: previousUserError } = await userDb.from('users')
        .select('telegram_id').eq('telegram_id', chatId).maybeSingle();
      if (previousUserError) throw previousUserError;
      isNewTelegramUser = !previousUser;
      const { error: userUpsertError } = await userDb.from('users').upsert({
        telegram_id: chatId,
        first_name: msg.from?.first_name || 'User',
        ...(isNewTelegramUser ? { trial_started_at: new Date().toISOString() } : {})
      }, { onConflict: 'telegram_id' });
      if (userUpsertError) throw userUpsertError;
    } catch (userError) {
      console.error('[Telegram] Не вдалося зберегти користувача для розсилок:', userError.message);
    }
  }

  if (text.startsWith('/start')) {
    const startPayload = text.trim().split(/\s+/, 2)[1] || '';
    if (startPayload === 'buy_premium') {
      const starsPrice = Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 0);
      if (process.env.PAYMENTS_ENABLED !== 'true' || !Number.isSafeInteger(starsPrice) || starsPrice < 1) {
        await sendTelegramMessage(chatId, 'Оплата Premium тимчасово вимкнена. Планова ціна — 180 ⭐ за 30 днів без автоматичного продовження.');
        return;
      }
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendInvoice`, {
          chat_id: chatId,
          title: 'ЗНАЙДЕНО Premium — 30 днів',
          description: 'Premium на 30 днів: до 20 активних фільтрів та перевірка кожні 2 хвилини.',
          payload: 'znaideno_premium_monthly_v1',
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: 'Premium на 30 днів', amount: starsPrice }]
        });
      } catch (err) {
        console.error('Не вдалося створити Telegram Stars рахунок:', err.message);
        await sendTelegramMessage(chatId, 'Не вдалося створити рахунок. Спробуйте пізніше або напишіть на @esqide.');
      }
      return;
    }
    // Accept one referral attribution per Telegram account; never count self-referrals.
    const referralMatch = /^ref_(\d{1,20})$/.exec(startPayload);
    if (referralMatch && isNewTelegramUser && (supabaseAdmin || supabase)) {
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
          const { data: inviter, error: inviterReadError } = await referralDb
            .from('users').select('tariff,premium_until').eq('telegram_id', inviterId).maybeSingle();
          if (!inviterReadError && inviter) {
            const currentExpiry = inviter.premium_until ? Date.parse(inviter.premium_until) : 0;
            const rewardBase = Number.isFinite(currentExpiry) ? Math.max(Date.now(), currentExpiry) : Date.now();
            const nextExpiry = new Date(rewardBase + 3 * 24 * 60 * 60 * 1000).toISOString();
            const { error: rewardError } = await referralDb.from('users').update({
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
      `👋 <b>Вітаємо у ЗНАЙДЕНО 1.0.0!</b>\n\n` +
      `🔎 <b>Розумний пошук, який працює за тебе.</b>\n` +
      `Створи фільтр — і отримуй сповіщення, коли з’являються нові оголошення, що відповідають твоїм критеріям. Менше ручних перевірок, більше часу на важливе.\n\n` +
      `<b>Що вміє ЗНАЙДЕНО:</b>\n` +
      `🧠 <b>Пошук своїми словами:</b> опиши потрібний товар, бюджет, місто та стан.\n` +
      `🎯 <b>Гнучкі фільтри:</b> уточнюй критерії та відсіюй небажані варіанти.\n` +
      `🔔 <b>Автоматичні сповіщення:</b> отримуй ціну, опис, доступне фото та посилання на знайдену пропозицію.\n` +
      `📊 <b>Аналітика цін:</b> порівнюй пропозиції та переглядай орієнтовну медіанну ціну, коли достатньо схожих оголошень.\n` +
      `📉 <b>Контроль ціни:</b> отримуй сповіщення, якщо ціна вже відстежуваного оголошення знизилася.\n\n` +
      `🎁 <b>4 дні пробного періоду</b>\n` +
      `• До <b>3 фільтрів</b> одночасно.\n` +
      `• До <b>30 пошукових перевірок на день</b>.\n` +
      `• Перевірка приблизно кожні <b>5 хвилин</b>.\n\n` +
      `💎 <b>PREMIUM — 180 ⭐ / 30 днів у Mini App</b>\n` +
      `• До <b>20 фільтрів</b> і до <b>100 пошукових перевірок на день</b>.\n` +
      `• Перевірка приблизно кожні <b>2 хвилини</b>.\n\n` +
      `Після пробного періоду можна продовжити користуватися безкоштовним тарифом: <b>1 фільтр</b>, до <b>5 перевірок на день</b> і перевірка приблизно кожні <b>15 хвилин</b>.\n\n` +
      `👇 <i>Натисни кнопку нижче, відкрий ЗНАЙДЕНО та створи свій перший пошук.</i>\n\n` +
      `<i>Сервіс не гарантує виявлення кожного оголошення. Частота перевірок залежить від тарифу та доступності джерела.</i>`;

    const keyboard = {
      inline_keyboard: [[{ text: 'Відкрити ЗНАЙДЕНО', web_app: { url: SERVER_URL } }]]
    };
    await sendTelegramMessage(chatId, welcomeText, keyboard);
    return;
  }

  if (text.startsWith('/cancel_subscription')) {
    try {
      if (!(supabaseAdmin || supabase) || !TELEGRAM_BOT_TOKEN) throw new Error('Платіжний сервіс тимчасово недоступний');
      const { data: lastRecurringPayment, error: recurringReadError } = await (supabaseAdmin || supabase)
        .from('star_payments')
        .select('telegram_payment_charge_id,premium_until')
        .eq('telegram_id', chatId)
        .eq('activation_status', 'active')
        .eq('is_recurring', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recurringReadError) throw recurringReadError;
      if (!lastRecurringPayment) {
        await sendTelegramMessage(chatId, 'Не знайшли активної автопродовжуваної підписки для скасування. Якщо потрібна допомога, напишіть у підтримку платежів.');
        return;
      }
      const cancelResponse = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editUserStarSubscription`, {
        user_id: chatId,
        telegram_payment_charge_id: lastRecurringPayment.telegram_payment_charge_id,
        is_canceled: true
      }, { timeout: 10000 });
      if (!cancelResponse.data?.ok) throw new Error(cancelResponse.data?.description || 'Telegram не підтвердив скасування');
      await sendTelegramMessage(chatId, 'Автопродовження скасовано. Premium залишиться доступним до ' +
        new Date(lastRecurringPayment.premium_until || Date.now()).toLocaleDateString('uk-UA') +
        '. Повторного списання не буде.');
    } catch (err) {
      console.error('[Stars] Не вдалося скасувати підписку:', err.response?.data?.description || err.message);
      await sendTelegramMessage(chatId, 'Не вдалося скасувати автопродовження автоматично. Напишіть у підтримку платежів: @esqide.');
    }
    return;
  }

  if (text.startsWith('/paysupport') || text.startsWith('/support')) {
    await sendTelegramMessage(chatId,
      'Підтримка платежів ЗНАЙДЕНО. Опишіть проблему та, якщо є, дату платежу. Контакт: @esqide. Не надсилайте дані банківської картки чи паролі.');
    return;
  }

  if (text.startsWith('/terms')) {
    await sendTelegramMessage(chatId,
      'Умови ЗНАЙДЕНО: Premium надає доступ до додаткових функцій моніторингу на 30 днів після підтвердження платежу. Сервіс незалежний від OLX і не гарантує безперервну роботу стороннього сайту. Питання щодо платежів: @esqide. Повні юридичні дані постачальника та остаточні умови потрібно опублікувати до публічного запуску.');
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
  } catch (err) {
    console.error('[Telegram Webhook] Непередбачена помилка обробки update:', err.message);
    if (!res.headersSent) res.sendStatus(500);
  } finally {
    // Acknowledge only after processing finishes so Telegram can retry unexpected failures.
    if (!res.headersSent) res.sendStatus(200);
  }
});

let isWorkerRunning = false;
async function runBackgroundWorker() {
  if (isWorkerRunning || !supabase || !TELEGRAM_BOT_TOKEN) return;

  try {
    isWorkerRunning = true;
    const { data: filters, error: filtersError } = await supabase.from('filters').select('*').order('created_at', { ascending: true });
    const freeFilterProcessed = new Set();
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
        const access = deriveAccess(filterOwner || {}, filterOwner?.is_admin === true);
        const ownerTrial = access.hasActiveTrial;
        const ownerPremium = access.hasActivePremium;
        if (!ownerPremium && !ownerTrial && filterOwner?.is_admin !== true) {
          if (freeFilterProcessed.has(String(filter.user_id))) continue;
          freeFilterProcessed.add(String(filter.user_id));
        }
        const intervalMs = access.checkIntervalMinutes * 60 * 1000;
        const lastCheckedAt = filter.last_checked_at ? Date.parse(filter.last_checked_at) : 0;
        if (Number.isFinite(lastCheckedAt) && lastCheckedAt > 0 && Date.now() - lastCheckedAt < intervalMs) continue;

        let targetUrl = filter.query ? filter.query.trim() : '';

        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          const citySlug = getOlxCitySlug(filter.city);
          const searchPath = citySlug
            ? `https://www.olx.ua/uk/${citySlug}/q-${encodeURIComponent(targetUrl)}/`
            : `https://www.olx.ua/uk/list/q-${encodeURIComponent(targetUrl)}/`;
          if (filter.min_price || filter.max_price) {
            const searchMin = filter.min_price ? `search%5Bfilter_float_price%3Afrom%5D=${filter.min_price}` : '';
            const searchMax = filter.max_price ? `search%5Bfilter_float_price%3Ato%5D=${filter.max_price}` : '';
            const queryParams = [searchMin, searchMax].filter(Boolean).join('&');
            targetUrl = `${searchPath}?${queryParams}`;
          } else {
            targetUrl = searchPath;
          }
          console.log(`[OLX search] filter=${filter.id} cityScope=${citySlug || 'all'}`);
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
        // search card. Fetch full descriptions only after date and city filtering below,
        // avoiding up to 30 unnecessary sequential network requests for unrelated ads.
        const needsFullDescription = criteria.includeTerms.length > 0 || criteria.anyTerms.length > 0 || criteria.excludeTerms.length > 0;
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
        const dateEligibleItems = parsedItems.filter(item => {
          const link = String(item.link || '').trim().replace(/\/$/, '');
          return isPublishedToday(item.locationDate) || knownLinks.has(link);
        });
        const locationEligibleItems = dateEligibleItems.filter(item => locationMatches(item.locationDate, requestedLocation));
        if (needsFullDescription) {
          // Limit detail-page requests to ads that could actually be notified.
          // A small concurrency cap keeps the worker responsive without hammering OLX.
          for (let i = 0; i < locationEligibleItems.length; i += 3) {
            const batch = locationEligibleItems.slice(i, i + 3);
            await Promise.all(batch.map(async item => {
              const fullDescription = await fetchListingDescription(item.link);
              item.detailsLoaded = Boolean(fullDescription);
              if (fullDescription) item.description = fullDescription;
            }));
          }
        }
        const criteriaEvaluations = locationEligibleItems.map(item => {
          // If the detail page could not be read, don't claim the item passed
          // explicit required/excluded-word rules using incomplete card text.
          if (needsFullDescription && !item.detailsLoaded) {
            return { item, matches: false, reason: 'description_unavailable' };
          }
          const result = applyCriteriaToListing({
            ...item,
            ageMinutes: getListingAgeMinutes(item.locationDate)
          }, criteria);
          return { item, matches: result.matches, reason: result.reason || 'matched' };
        });
        const items = criteriaEvaluations.filter(result => result.matches).map(result => result.item);
        const rejectionCounts = criteriaEvaluations.reduce((counts, result) => {
          if (!result.matches) counts[result.reason] = (counts[result.reason] || 0) + 1;
          return counts;
        }, {});
        console.log(`[Worker Diagnostics] filter=${filter.id} parsed=${parsedItems.length} dateEligible=${dateEligibleItems.length} locationEligible=${locationEligibleItems.length} criteriaEligible=${items.length} rejected=${JSON.stringify(rejectionCounts)} known=${knownLinks.size} city="${requestedLocation}" sampleLocations=${JSON.stringify(parsedItems.slice(0, 5).map(item => String(item.locationDate || '').slice(0, 100)))}`);
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
            : `${SERVER_URL}/assets/no-photo.png`;
          
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
    serverDatabaseUsesServiceRole: Boolean(SUPABASE_SERVICE_ROLE_KEY),
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
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      url: targetWebhookUrl,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'pre_checkout_query']
    }, { timeout: 10000 });
    if (!response.data?.ok) throw new Error(response.data?.description || 'Telegram відхилив реєстрацію webhook');
    console.log(`✅ Telegram Webhook встановлено з перевіркою секретного заголовка: ${targetWebhookUrl}`);
  } catch (err) {
    console.error('Помилка встановлення Webhook:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await registerWebhook();
});