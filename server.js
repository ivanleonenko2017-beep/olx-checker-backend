const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { normalizeCriteria, applyCriteriaToListing, canUseUnverifiedStorageFallback, parseNaturalLanguageQuery, estimateBargainPrice, median } = require('./smart-search');
const { deriveAccess, canCreateFilter, TRIAL_DAYS, PREMIUM_PRICE_UAH } = require('./access-policy');
const { isTestPremiumBypassEnabled } = require('./premium-bypass');
const { buildOlxPageUrl, mergeUniqueOlxItems } = require('./olx-pagination');
const { escapeTelegramHtml } = require('./telegram-html');
const { getTelegramRetryDelaySeconds, isTelegramBlockedError } = require('./telegram-delivery-utils');
const { sanitizeSearchUrl, hashUserId, safeText, compactRejectedCards, evaluateCriteriaFunnel, summarizeCriteria, isAuthorizedAdmin } = require('./search-telemetry');
const { consumeRateLimit, isAdminCommandAuthorized, formatDiagnosticMessages, formatStatusMessage } = require('./admin-command-utils');

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
let telegramBotUsernameCache = '';
let telegramBotUsernameCacheAt = 0;
async function getTelegramBotUsername() {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, '');
  if (telegramBotUsernameCache && Date.now() - telegramBotUsernameCacheAt < 15 * 60 * 1000) return telegramBotUsernameCache;
  if (!TELEGRAM_BOT_TOKEN) return '';
  try {
    const response = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`, { timeout: 5000 });
    const username = response.data?.ok ? String(response.data.result?.username || '') : '';
    if (username) { telegramBotUsernameCache = username.replace(/^@/, ''); telegramBotUsernameCacheAt = Date.now(); }
    return telegramBotUsernameCache;
  } catch (error) { console.warn('[Telegram] Не вдалося отримати username бота:', error.message); return ''; }
}

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

  if (await isAuthorizedAdmin(user, checkIsAdmin)) {
    req.adminUser = user;
    return next();
  }

  return res.status(403).json({ 
    success: false, 
    error: 'Forbidden: Доступ заборонено (потрібні підтверджені права адміністратора)' 
  });
}

async function markTelegramBlocked(chatId) {
  const db = supabaseAdmin || supabase;
  const telegramId = Number(chatId);
  if (!db || !Number.isSafeInteger(telegramId) || telegramId <= 0) return;
  try {
    const { error } = await db.from('users')
      .update({ telegram_blocked_at: new Date().toISOString() })
      .eq('telegram_id', telegramId);
    if (error) console.warn('[Telegram] Не вдалося позначити заблокованого користувача:', error.message);
  } catch (error) {
    console.warn('[Telegram] Помилка збереження статусу блокування:', error.message);
  }
}


async function sendTelegramMessage(chatId, text, replyMarkup = null, useHtml = true, attempt = 0) {
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
    const status = err.response?.status;
    const description = err.response?.data?.description || err.message;
    if (isTelegramBlockedError(err)) {
      await markTelegramBlocked(chatId);
      console.warn(`[Telegram] Бот заблокований користувачем ${chatId}; повторні спроби припинено.`);
      return false;
    }
    if (status === 429 && attempt < 2) {
      const retrySeconds = getTelegramRetryDelaySeconds(err);
      console.warn(`[Telegram] 429 для чату ${chatId}; повтор через ${retrySeconds} с.`);
      await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
      return sendTelegramMessage(chatId, text, replyMarkup, useHtml, attempt + 1);
    }
    if (useHtml && /can't parse entities|unsupported start tag/i.test(description)) {
      console.warn(`[Telegram] HTML parse error for chat ${chatId}; retrying as plain text`);
      return sendTelegramMessage(chatId, text, replyMarkup, false, attempt);
    }
    console.error(`[Telegram] sendMessage failed for chat ${chatId} (HTTP ${status || 'network'}): ${description}`);
    return false;
  }
}

async function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup = null, attempt = 0) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const fullPhotoUrl = photoUrl.startsWith('/') ? `${SERVER_URL}${photoUrl}` : photoUrl;
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      chat_id: chatId,
      photo: fullPhotoUrl,
      caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }, { timeout: 8000 });
    if (response.data?.ok === true) return true;
    console.warn(`[Telegram] sendPhoto не підтвердив доставку для чату ${chatId}: `, response.data?.description || 'невідома помилка');
    return sendTelegramMessage(chatId, caption, replyMarkup);
  } catch (err) {
    if (isTelegramBlockedError(err)) {
      await markTelegramBlocked(chatId);
      console.warn(`[Telegram] Бот заблокований користувачем ${chatId}; фото та повідомлення більше не надсилаються.`);
      return false;
    }
    if (err.response?.status === 429 && attempt < 1) {
      const retrySeconds = getTelegramRetryDelaySeconds(err);
      console.warn(`[Telegram] 429 для фото чату ${chatId}; повтор через ${retrySeconds} с.`);
      await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
      return sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup, attempt + 1);
    }
    return sendTelegramMessage(chatId, caption, replyMarkup);
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

function getLocationAliases(requestedRaw, requested) {
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
  return aliases[requestedRaw.toLocaleLowerCase('uk-UA')] || aliases[requested] || [];
}

function locationMatches(locationDate, requestedLocation) {
  const requestedRaw = String(requestedLocation || '').trim();
  const requested = normalizeLocationText(requestedRaw);
  if (!requested || ['всі міста', 'вся україна', 'уся україна'].some(value => normalizeLocationText(value) === requested)) return true;
  const label = String(locationDate || '').split(/\s*[-–—]\s*/)[0].split(',')[0].trim();
  const actual = normalizeLocationText(label);
  if (!actual) return false;
  const accepted = new Set([requested, ...getLocationAliases(requestedRaw, requested).map(normalizeLocationText)]);
  return accepted.has(actual);
}

function locationMatchesCardText(cardText, requestedLocation) {
  const text = String(cardText || '').replace(/\s+/g, ' ').trim();
  const lowerText = text.toLocaleLowerCase('uk-UA');
  const requestedRaw = String(requestedLocation || '').trim();
  const requested = normalizeLocationText(requestedRaw);
  if (!text || !requested) return false;

  const variants = [requestedRaw, ...getLocationAliases(requestedRaw, requested)]
    .map(value => String(value || '').trim().toLocaleLowerCase('uk-UA'))
    .filter(Boolean);
  const dateAfterCity = /^\s*(?:,\s*[^-–—]{1,60})?\s*[-–—]\s*(?:(?:сьогодні|сегодня|today)(?:\s+о\s+\d{1,2}[:.]\d{2})?|\d{1,2}\s+\p{L}{3,}\s+\d{4})/iu;

  return variants.some(variant => {
    let searchFrom = 0;
    while (searchFrom < lowerText.length) {
      const position = lowerText.indexOf(variant, searchFrom);
      if (position < 0) return false;
      const before = lowerText.slice(Math.max(0, position - 20), position);
      const previousCharacter = position > 0 ? lowerText[position - 1] : '';
      const isBoundary = position === 0 || !/\p{L}/u.test(previousCharacter) ||
        /(?:нове|новий|нова|вживане|вживаний|new|used|б[/.]?у)$/iu.test(before);
      const after = lowerText.slice(position + variant.length);
      if (isBoundary && dateAfterCity.test(after)) return true;
      searchFrom = position + 1;
    }
    return false;
  });
}

async function parseOlxPage(targetUrl, minPrice, maxPrice, query = '') {
  const pageStartedAt = Date.now();
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
  const pageMeta = {
    requestedUrl: sanitizeSearchUrl(targetUrl),
    finalUrl: sanitizeSearchUrl(response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || targetUrl),
    status: Number(response.status || 0),
    durationMs: Date.now() - pageStartedAt,
    responseBytes: Buffer.byteLength(html, 'utf8'),
    declaredTotal: null,
    antiBotDetected: false
  };
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
    pageMeta.antiBotDetected = true;
    console.warn(`[OLX search] Block detected: status=${response.status}, reason=${response.status === 403 || response.status === 429 ? 'http-status' : matchedBlockPattern?.source || 'unknown'}`);
    const error = new Error('OLX тимчасово обмежив доступ до пошуку. Спробуйте пізніше.');
    error.code = 'OLX_BLOCKED';
    throw error;
  }

  const $ = cheerio.load(html);
  const rawItems = [];
  const adLinksFound = $('a[href*="/d/"], a[href*="/obyavlenie/"]').length;

  // Do not reject cards here based on generic accessory/repair words.
  // These words may appear in a genuine phone listing (e.g. battery replaced,
  // camera description). User exclusions belong to applyCriteriaToListing,
  // where the complete criteria and negation context are available.
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

  // OLX can mix card markup versions on the same result page. Do not run
  // the ancestor fallback only when the primary selector finds zero cards:
  // that silently drops cards whenever the primary selector finds only a
  // partial subset. Supplement the selected cards from every unique ad link.
  const primaryCardCount = cards.length;
  const fallbackNodes = new Set();
  $('a[href*="/d/"], a[href*="/obyavlenie/"]').each((_, linkEl) => {
    let node = $(linkEl).parent();
    for (let depth = 0; depth < 8 && node.length; depth++, node = node.parent()) {
      const text = node.text().replace(/\s+/g, ' ').trim();
      const hasTitle = node.find('h1, h2, h3, h4, h5, h6, [data-testid*="title"], [data-cy*="title"]').length > 0;
      const hasPrice = /грн|₴/.test(text);
      if (hasTitle && hasPrice && text.length < 2500) {
        const el = node.get(0);
        if (el && !fallbackNodes.has(el)) {
          fallbackNodes.add(el);
          cards = cards.add(node);
        }
        break;
      }
    }
  });
  const supplementalCardCount = Math.max(0, cards.length - primaryCardCount);
  const parserStats = { primaryCards: primaryCardCount, supplementalCards: supplementalCardCount, adLinksFound, skippedNoTitle: 0, skippedNoPrice: 0, skippedDuplicate: 0, skippedInvalidLink: 0, maxItemsReached: false };
  const seenAdLinks = new Set();

  cards.each((index, element) => {
    if (rawItems.length >= 200) {
      parserStats.maxItemsReached = true;
      return false;
    }

    $(element).find('style, script').remove();
    const title = $(element).find(
      'h1, h2, h3, h4, h5, h6, [data-testid*="title"], [data-cy*="title"]'
    ).first().text().trim();
    if (!title) { parserStats.skippedNoTitle++; return; }

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

    if (!Number.isFinite(numericPrice) || numericPrice <= 0) { parserStats.skippedNoPrice++; return; }
    if (minPrice && numericPrice < parseInt(minPrice, 10)) return;
    if (maxPrice && numericPrice > parseInt(maxPrice, 10)) return;

    const rawLink = $(element).find('a[href*="/d/"], a[href*="/obyavlenie/"]').first().attr('href') || '';
    let parsedLink;
    try {
      parsedLink = new URL(rawLink, 'https://www.olx.ua');
    } catch (_) {
      parserStats.skippedInvalidLink++;
      return;
    }
    const linkHost = parsedLink.hostname.toLowerCase();
    if (parsedLink.protocol !== 'https:' ||
        !(linkHost === 'olx.ua' || linkHost.endsWith('.olx.ua')) ||
        !/(?:\/d\/|\/obyavlenie\/)/i.test(parsedLink.pathname)) {
      parserStats.skippedInvalidLink++;
      return;
    }
    parsedLink.search = '';
    parsedLink.hash = '';
    const link = parsedLink.toString();

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

    // Preserve the complete visible card text: OLX condition badges and specs
    // are not always included in the title or description fields.
    const cardText = $(element).text().replace(/\s+/g, ' ').trim().slice(0, 2500);
    let locationDate = $(element).find('[data-testid="location-date"], [data-cy="location-date"]').first().text().trim();
    if (!locationDate) {
      const locationCandidates = $(element).find('[class*="location"], [class*="date"]').toArray()
        .map(node => $(node).text().replace(/\s+/g, ' ').trim())
        .filter(value => value && value.length < 120 && /(?:сьогодні|сегодня|today|\d{1,2}\s+\p{L}{3,})/iu.test(value));
      locationDate = locationCandidates.find(value => /[-–—]/.test(value)) || '';
    }
    const descriptionCandidate = $(element).find(
      '[data-testid="ad-description"], [data-cy="ad-description"], [class*="description"], p'
    ).first().text().replace(/\s+/g, ' ').trim();
    const description = descriptionCandidate && descriptionCandidate.length > 12
      ? descriptionCandidate.slice(0, 280)
      : 'Відкрийте оголошення на OLX, щоб переглянути повний опис продавця.';

    const normalizedAdLink = link.split('?')[0].replace(/\/$/, '').toLocaleLowerCase('uk-UA');
    if (seenAdLinks.has(normalizedAdLink)) { parserStats.skippedDuplicate++; return; }
    if (title && numericPrice > 0 && rawLink) {
      seenAdLinks.add(normalizedAdLink);
      rawItems.push({
        id: 'ad_' + crypto.randomBytes(4).toString('hex'),
        title,
        price: numericPrice,
        priceText: `${numericPrice.toLocaleString('uk-UA')} грн`,
        link,
        rawImgUrl,
        proxyImg: rawImgUrl ? `${SERVER_URL}/api/proxy-image?url=${encodeURIComponent(rawImgUrl)}` : `${SERVER_URL}/assets/no-photo.svg`,
        locationDate,
        cardText,
        description
      });
    }
  });

  console.log(`[OLX parse] primaryCards=${primaryCardCount}, supplementalCards=${supplementalCardCount}, adLinksFound=${adLinksFound}, parsed=${rawItems.length}, skipped=${JSON.stringify(parserStats)}`);
  const prices = rawItems.map(i => i.price).filter(price => Number.isFinite(price) && price > 0);
  // Keep the legacy API field name for compatibility, but use a robust median.
  // No market-price estimate is returned with fewer than five listings.
  const averagePrice = prices.length >= 5 ? median(prices) : 0;

  if (!rawItems.length && /olx/i.test(targetUrl) && !/search|listing|og:/.test(pageText)) {
    const error = new Error('Не вдалося розпізнати сторінку OLX. Сайт міг змінити розмітку або тимчасово обмежити доступ.');
    error.code = 'OLX_PARSE_EMPTY';
    throw error;
  }

  return { items: rawItems, averagePrice, parserStats, pageMeta };
}

async function parseOlx(targetUrl, minPrice, maxPrice, query = '', requestedLocation = '', traceContext = {}) {
  const requestId = String(traceContext.requestId || crypto.randomBytes(6).toString('hex')).slice(0, 16);
  const source = ['manual', 'background', 'filter_warmup', 'diagnostic'].includes(traceContext.source)
    ? traceContext.source : 'unknown';
  const userHash = hashUserId(traceContext.userId, TELEGRAM_WEBHOOK_SECRET);
  const criteriaSummary = summarizeCriteria(traceContext.criteria || {});
  const cityScoped = Boolean(String(requestedLocation || '').trim()) && !/^https?:\/\//i.test(String(query || '').trim());
  const configuredPageLimit = Number.parseInt(process.env.OLX_SEARCH_MAX_PAGES || '2', 10);
  const pageLimit = cityScoped
    ? Math.min(3, Math.max(1, Number.isFinite(configuredPageLimit) ? configuredPageLimit : 2))
    : 1;
  const pages = [];
  const pageTraces = [];
  let previousUniqueCount = 0;
  let stopReason = 'page_limit';
  const startedAt = new Date().toISOString();
  console.log('[SEARCH_TRACE] ' + JSON.stringify({
    event: 'search_start', requestId, at: startedAt, source, userHash,
    queryHash: hashUserId(query, TELEGRAM_WEBHOOK_SECRET), criteria: criteriaSummary,
    requestedLocation: safeText(requestedLocation, 80),
    targetUrl: sanitizeSearchUrl(targetUrl), pageLimit
  }));

  for (let page = 1; page <= pageLimit; page++) {
    const pageUrl = page === 1 ? targetUrl : buildOlxPageUrl(targetUrl, page);
    try {
      const result = await parseOlxPage(pageUrl, minPrice, maxPrice, query);
      pages.push(result.items);
      const merged = mergeUniqueOlxItems(pages, 600);
      const newAfterDedup = Math.max(0, merged.length - previousUniqueCount);
      const pageTrace = {
        at: new Date().toISOString(), page, requestedUrl: result.pageMeta?.requestedUrl || sanitizeSearchUrl(pageUrl),
        finalUrl: result.pageMeta?.finalUrl || sanitizeSearchUrl(pageUrl),
        httpStatus: result.pageMeta?.status || null,
        durationMs: result.pageMeta?.durationMs ?? null,
        responseBytes: result.pageMeta?.responseBytes ?? null,
        antiBotDetected: Boolean(result.pageMeta?.antiBotDetected),
        declaredTotal: result.pageMeta?.declaredTotal ?? null,
        recommendationClassification: 'not_instrumented',
        cardsOnPage: (result.parserStats?.primaryCards || 0) + (result.parserStats?.supplementalCards || 0),
        cardsParsed: result.items.length, newAfterDedup,
        uniqueTotal: merged.length, parserStats: result.parserStats || {}
      };
      pageTraces.push(pageTrace);
      console.log('[SEARCH_TRACE] ' + JSON.stringify({
        event: 'search_page', requestId, source, ...pageTrace
      }));
      if (result.items.length === 0) { stopReason = 'empty_page'; break; }
      if (merged.length === previousUniqueCount) { stopReason = 'no_new_unique_cards'; break; }
      previousUniqueCount = merged.length;
    } catch (error) {
      stopReason = error.response?.status === 429 ? 'http_429' :
        (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'timeout' : 'upstream_error');
      console.error('[SEARCH_TRACE] ' + JSON.stringify({
        event: 'search_page_error', requestId, source, at: new Date().toISOString(), page,
        requestedUrl: sanitizeSearchUrl(pageUrl),
        httpStatus: Number(error.response?.status || 0) || null,
        errorCode: safeText(error.code || 'UPSTREAM_ERROR', 48),
        stopReason, antiBotDetected: error.code === 'OLX_BLOCKED' || [403, 429].includes(Number(error.response?.status || 0))
      }));
      if (page === 1) throw error;
      break;
    }
  }

  const items = mergeUniqueOlxItems(pages, 600);
  const prices = items.map(item => item.price).filter(price => Number.isFinite(price) && price > 0);
  console.log('[SEARCH_TRACE] ' + JSON.stringify({
    event: 'search_pages_complete', requestId, source, at: new Date().toISOString(),
    pageCount: pageTraces.length, pageLimit, stopReason,
    parsedAcrossPages: pageTraces.reduce((sum, p) => sum + p.cardsParsed, 0),
    afterDedup: items.length, pages: pageTraces
  }));
  return { items, averagePrice: prices.length >= 5 ? median(prices) : 0, requestId, pageTraces, stopReason };
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
    // Detail pages are fetched only when the search card lacks a required spec.
    // A small delay and bounded concurrency below keep OLX requests controlled.
    await new Promise(resolve => setTimeout(resolve, 200));
    const response = await axios.get(key, {
      headers: { ...HEADERS, Referer: 'https://www.olx.ua/' },
      timeout: 8000,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 300
    });
    const $ = cheerio.load(String(response.data || ''));
    let description = $('[data-testid="ad-description"], [data-cy="ad-description"], [data-testid*="description"], [class*="description"]').first().text().trim();
    const contextParts = [];
    const pageTitle = $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') || $('title').text().trim();
    if (pageTitle) contextParts.push(pageTitle);
    let conditionMarker = '';

    // OLX product specs can be present in JSON-LD even when the search card
    // contains only a model title and price.
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        const candidates = Array.isArray(json) ? json : [json];
        for (const item of candidates) {
          if (!item || typeof item !== 'object') continue;
          if (!description && typeof item.description === 'string' && item.description.trim()) {
            description = item.description.trim();
          }
          const rawCondition = item.itemCondition ?? item.condition ??
            (Array.isArray(item.additionalProperty)
              ? item.additionalProperty.find(prop => /condition|стан/i.test(String(prop?.name || '')))?.value
              : '');
          const conditionValue = typeof rawCondition === 'string'
            ? rawCondition
            : String(rawCondition?.name || rawCondition?.['@id'] || '');
          if (/UsedCondition|pre.?owned|вживан|уживан|б\/?у/i.test(conditionValue)) {
            conditionMarker = 'Стан оголошення: вживаний';
          } else if (/NewCondition|brand.?new|новий|нова|нове/i.test(conditionValue)) {
            conditionMarker = 'Стан оголошення: новий';
          }
          if (Array.isArray(item.additionalProperty)) {
            for (const property of item.additionalProperty) {
              const name = String(property?.name || '').trim();
              const value = String(property?.value ?? property?.valueReference?.name ?? '').trim();
              if (name && value && /memory|storage|capacity|пам.?ят|обсяг|объем|стан|condition|модель|model/i.test(name)) {
                contextParts.push(name + ': ' + value);
              }
            }
          }
        }
      } catch (_) {}
    });

    const visibleCondition = $('[data-testid*="condition"], [data-cy*="condition"], [class*="condition"]').text().trim();
    if (!conditionMarker && /вживан|уживан|б\/?у|used|pre.?owned/i.test(visibleCondition)) {
      conditionMarker = 'Стан оголошення: вживаний';
    } else if (!conditionMarker && /новий|нова|нове|new/i.test(visibleCondition)) {
      conditionMarker = 'Стан оголошення: новий';
    }

    // Include only specification/attribute containers, not the whole page:
    // whole-page text may contain unrelated recommendations with other capacities.
    const specificationSelectors = [
      '[data-testid*="attribute"]', '[data-cy*="attribute"]',
      '[data-testid*="parameter"]', '[data-cy*="parameter"]',
      '[data-testid*="specification"]', '[data-cy*="specification"]',
      '[class*="attribute"]', '[class*="parameter"]',
      '[class*="characteristic"]', '[class*="specification"]'
    ].join(', ');
    $(specificationSelectors).each((_, element) => {
      const value = $(element).text().replace(/\s+/g, ' ').trim();
      if (value && value.length <= 1000) contextParts.push(value);
    });

    if (!description) description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    description = String(description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (conditionMarker) contextParts.push(conditionMarker);
    const searchContext = [...new Set(contextParts)].join('. ');
    const result = [description, searchContext].filter(Boolean).join('. ').replace(/\s+/g, ' ').slice(0, 5000);

    if (result && !/verify you are human|access denied|robot check|підтверд.{0,20}що ви людина/i.test(result)) {
      listingDescriptionCache.set(key, { description: result, expiresAt: Date.now() + 10 * 60 * 1000 });
      if (listingDescriptionCache.size > 500) {
        const oldestKey = listingDescriptionCache.keys().next().value;
        listingDescriptionCache.delete(oldestKey);
      }
      return result;
    }
  } catch (error) {
    console.warn('[Smart Search details] Не вдалося отримати контекст оголошення:', error.response?.status || error.code || 'request-failed');
  }
  listingDescriptionCache.set(key, { description: '', expiresAt: Date.now() + 60 * 1000 });
  return '';
}

app.get('/api/search', userAuthMiddleware, async (req, res) => {
  const startedAt = Date.now();
  const testPremiumBypass = isTestPremiumBypassEnabled(process.env);
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
        const storageQueryTerms = [...(parsedCriteria.includeTerms || []), ...(parsedCriteria.anyTerms || [])]
          .map(term => String(term).match(/^(\d{2,4})\s*(?:гб|gb)$/iu)?.[1])
          .filter(Boolean);
        const upstreamQuery = [...new Set([cleanQ, ...storageQueryTerms])].join(' ').trim();
        const searchPath = citySlug
          ? `https://www.olx.ua/uk/${citySlug}/q-${encodeURIComponent(upstreamQuery)}/`
          : `https://www.olx.ua/uk/list/q-${encodeURIComponent(upstreamQuery)}/`;
        const searchMin = minPrice ? `search%5Bfilter_float_price%3Afrom%5D=${minPrice}` : '';
        const searchMax = maxPrice ? `search%5Bfilter_float_price%3Ato%5D=${maxPrice}` : '';
        const queryParams = [searchMin, searchMax].filter(Boolean).join('&');
        targetUrl = queryParams ? `${searchPath}?${queryParams}` : searchPath;
      }
    }

    if (!targetUrl) return res.status(400).json({ error: 'Укажіть пошуковий запит' });

    const requestedLocation = String(city || '').trim();
    const searchTrace = { source: 'manual', userId: req.telegramUser.id, criteria: {
      modelTerm: criteria.modelTerm || '', includeTerms: criteria.includeTerms, anyTerms: criteria.anyTerms,
      excludeTerms: criteria.excludeTerms, condition: criteria.condition, city: criteria.city,
      minPrice: criteria.minPrice, maxPrice: criteria.maxPrice
    }};
    const { items: parsedItems, requestId } = await parseOlx(targetUrl, minPrice, maxPrice, query, requestedLocation, searchTrace);
    // OLX card markup is inconsistent: the dedicated location node can be
    // absent or point at a date/metadata wrapper. Search the complete visible
    // card text as a fallback before dropping an otherwise valid local result.
    const locationDiagnostics = requestedLocation
      ? parsedItems.map(item => ({
          title: String(item.title || '').slice(0, 100),
          locationDate: String(item.locationDate || '').slice(0, 100),
          matchedLocationDate: locationMatches(item.locationDate, requestedLocation),
          matchedCardText: locationMatchesCardText(item.cardText, requestedLocation),
          cardTextLocationExcerpt: (String(item.cardText || '').match(/.{0,35}(?:черніг|черниг|chernig).{0,45}/iu) || [])[0] || ''
        }))
      : [];
    const locationItems = parsedItems.filter(item =>
      locationMatches(item.locationDate, requestedLocation) ||
      (!item.locationDate && locationMatchesCardText(item.cardText, requestedLocation))
    );
    if (requestedLocation) {
      console.log('[OLX city diagnostics] ' + JSON.stringify({
        requestedLocation,
        parsed: parsedItems.length,
        matched: locationItems.length,
        candidates: locationDiagnostics
      }));
    }
    const cityRejected = parsedItems.filter(item => !(
      locationMatches(item.locationDate, requestedLocation) ||
      (!item.locationDate && locationMatchesCardText(item.cardText, requestedLocation))
    ));
    const requestedCondition = String(condition || 'all').trim().toLowerCase();
    if (requestedCondition !== 'all') criteria.condition = requestedCondition;
    const cityRejectedCards = cityRejected.map(item => ({
      listingKey: hashUserId(item.link, TELEGRAM_WEBHOOK_SECRET),
      url: sanitizeSearchUrl(item.link),
      stage: 'city',
      reason: 'city_mismatch',
      value: safeText(item.locationDate || item.cardText, 100)
    }));


    // Storage is often absent from OLX search cards and exists only on the
    // individual ad page. Enrich matching iPhone candidates before rejecting
    // them for a missing capacity; do not make every search fetch every ad.
    const storageRequirements = [...criteria.includeTerms, ...criteria.anyTerms]
      .filter(term => /^\d{2,4}\s*(?:гб|gb)$/iu.test(term));
    let detailsEnriched = 0;
    if (storageRequirements.length) {
      const candidates = locationItems.filter(item =>
        /(?:iphone|айфон)/iu.test(String(item.title || '')) &&
        applyCriteriaToListing(item, criteria).reason === 'missing_required_term'
      ).slice(0, 5); // Bound detail-page requests; unknown specs use the safe fallback below.
      let nextCandidate = 0;
      const workerCount = Math.min(5, candidates.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextCandidate < candidates.length) {
          const item = candidates[nextCandidate++];
          const detailContext = await fetchListingDescription(item.link);
          if (detailContext) {
            item.description = [item.description, detailContext].filter(Boolean).join(' ');
            detailsEnriched++;
          }
        }
      });
      await Promise.all(workers);
    }

    const stagedFunnel = evaluateCriteriaFunnel(locationItems, criteria);
    const rejectionReasons = {};
    const rejectedCards = [...cityRejectedCards];
    const items = locationItems.filter(item => {
      const result = applyCriteriaToListing(item, criteria);
      if (result.matches) return true;

      // OLX is queried with the requested capacity. Keep only iPhone cards
      // whose capacity is absent, never cards explicitly showing another size.
      if (result.reason === 'missing_required_term' &&
          storageRequirements.length &&
          canUseUnverifiedStorageFallback(item, criteria)) {
        item.capacityUnverified = true;
        item.capacityVerificationNote = 'Обсяг пам’яті не вказаний у картці OLX — перевірте його в оголошенні.';
        return true;
      }

      rejectionReasons[result.reason] = (rejectionReasons[result.reason] || 0) + 1;
      rejectedCards.push({
        listingKey: hashUserId(item.link, TELEGRAM_WEBHOOK_SECRET),
        url: sanitizeSearchUrl(item.link), stage: ({
          model_mismatch: 'model', wrong_product_type: 'model',
          missing_required_term: storageRequirements.length ? 'memory_or_required_terms' : 'required_terms',
          missing_any_alternative: 'required_terms', condition_mismatch: 'condition',
          below_min_price: 'price', above_max_price: 'price', excluded_term: 'excluded_words'
        })[result.reason] || 'other',
        reason: result.reason,
        value: safeText(result.reason === 'below_min_price' || result.reason === 'above_max_price'
          ? String(item.price || '') : item.title, 100)
      });
      return false;
    });
    const comparablePriceValues = items
      .filter(item => item.capacityUnverified !== true)
      .map(item => Number(item.price))
      .filter(price => Number.isFinite(price) && price > 0);
    const matchingAveragePrice = comparablePriceValues.length >= 5 ? median(comparablePriceValues) : 0;
    console.log('[SEARCH_TRACE] ' + JSON.stringify({
      event: 'search_funnel', requestId, source: 'manual', at: new Date().toISOString(),
      parsed: parsedItems.length, afterDedup: parsedItems.length,
      afterCardParse: parsedItems.length, afterCity: locationItems.length,
      afterCriteria: items.length, criteriaStages: stagedFunnel.counts, detailsEnriched,
      capacityUnverified: items.filter(item => item.capacityUnverified === true).length,
      cityUnverified: items.filter(item => !item.locationDate && locationMatchesCardText(item.cardText, requestedLocation)).length,
      rejectedByReason: rejectionReasons,
      rejectedCards: compactRejectedCards(rejectedCards, 25).cards,
      rejectedCardsOmitted: compactRejectedCards(rejectedCards, 25).omitted,
      durationMs: Date.now() - startedAt
    }));
    console.log('[API search] Completed: parsed=' + parsedItems.length + ', cityMatched=' + locationItems.length + ', detailsEnriched=' + detailsEnriched + ', returned=' + items.length + ', rejected=' + JSON.stringify(rejectionReasons) + ', city=' + JSON.stringify(requestedLocation) + ', url=' + sanitizeSearchUrl(targetUrl) + ', smart=' + Boolean(parsedNaturalQuery) + ', requestId=' + requestId + ', durationMs=' + (Date.now() - startedAt));
    res.json({
      success: true,
      count: items.length,
      searchRequestId: requestId,
      averagePrice: matchingAveragePrice,
      items,
      plan: access.plan,
      searchesUsedToday: searchQuota.used,
      searchesLimitToday: Number.isFinite(access.searchLimit) ? access.searchLimit : null,
      searchesRemainingToday: Number.isFinite(searchQuota.remaining) ? searchQuota.remaining : null,
      ...(parsedNaturalQuery ? { parsedQuery: parsedNaturalQuery.query, criteria: parsedCriteria } : {})
    });
  } catch (error) {
    console.error(`[API search] Failed: code=${error.code || 'unknown'}, status=${error.response?.status || 'none'}, durationMs=${Date.now() - startedAt}`);
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
    const testPremiumBypass = isTestPremiumBypassEnabled(process.env);
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
      // Start the one-time 4-day trial on the first Mini App profile request.
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
      monobankJarUrl: process.env.MONOBANK_JAR_URL || process.env.MONOBANK_JAR_LINK || '', // Donation link only; not a Premium checkout.
      user: userData,
      stats: { totalReferrals },
      telegramBotUsername: await getTelegramBotUsername()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/user/filters', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    if (!supabase) return res.json({ success: true, filters: [] });

    const { data, error } = await supabase.from('filters').select('*').eq('user_id', userId).order('created_at', { ascending: true });
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
    const testPremiumBypass = isTestPremiumBypassEnabled(process.env);
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Перевірка доступу тимчасово недоступна. Спробуйте пізніше.' });
    }
    const userId = req.telegramUser.id;
    const { query, minPrice, maxPrice, city, condition } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Введіть коректний пошуковий запит' });
    }

    const rawQuery = query.trim();
    const parsedQuery = /^https?:\/\//i.test(rawQuery) ? null : parseNaturalLanguageQuery(rawQuery);
    const parsedCriteria = parsedQuery?.criteria || {};
    const cleanQuery = parsedQuery?.query || rawQuery;
    const submittedCriteria = req.body.criteria && typeof req.body.criteria === 'object'
      ? req.body.criteria
      : {};
    const hasText = value => Array.isArray(value) ? value.length > 0 : String(value || '').trim().length > 0;
    const criteriaInput = { ...parsedCriteria, ...submittedCriteria };

    // Empty/default form fields must not erase constraints parsed from the
    // original sentence. Non-empty manual values remain authoritative.
    if (!hasText(submittedCriteria.includeTerms)) criteriaInput.includeTerms = parsedCriteria.includeTerms || [];
    if (!hasText(submittedCriteria.anyTerms)) criteriaInput.anyTerms = parsedCriteria.anyTerms || [];
    if (!hasText(submittedCriteria.excludeTerms)) criteriaInput.excludeTerms = parsedCriteria.excludeTerms || [];
    if (!hasText(submittedCriteria.modelTerm)) criteriaInput.modelTerm = parsedCriteria.modelTerm || '';
    if (!submittedCriteria.includeTermsMode || submittedCriteria.includeTermsMode === 'all') {
      criteriaInput.includeTermsMode = parsedCriteria.includeTermsMode || submittedCriteria.includeTermsMode || 'all';
    }
    if (!submittedCriteria.photosOnly) criteriaInput.photosOnly = parsedCriteria.photosOnly === true;
    if (!Number(submittedCriteria.maxAgeMinutes)) criteriaInput.maxAgeMinutes = parsedCriteria.maxAgeMinutes || 0;

    const explicitCity = typeof city === 'string' ? city.trim() : '';
    const allCities = !explicitCity || ['всі міста', 'все міста', 'вся україна', 'уся україна']
      .some(value => normalizeLocationText(value) === normalizeLocationText(explicitCity));
    criteriaInput.city = allCities ? (parsedCriteria.city || explicitCity) : explicitCity;

    const explicitCondition = String(condition || '').trim().toLowerCase();
    criteriaInput.condition = explicitCondition && explicitCondition !== 'all'
      ? explicitCondition
      : (parsedCriteria.condition || 'all');

    const explicitMinPrice = minPrice !== undefined && minPrice !== null && minPrice !== '' && Number(minPrice) > 0
      ? minPrice
      : (parsedCriteria.minPrice || 0);
    const explicitMaxPrice = maxPrice !== undefined && maxPrice !== null && maxPrice !== '' && Number(maxPrice) > 0
      ? maxPrice
      : (parsedCriteria.maxPrice || 0);
    criteriaInput.minPrice = explicitMinPrice;
    criteriaInput.maxPrice = explicitMaxPrice;
    const criteria = normalizeCriteria(criteriaInput);

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
          const storageTerms = [...criteria.includeTerms, ...criteria.anyTerms]
            .map(term => String(term).match(/^(\d{2,4})\s*(?:гб|gb)$/iu)?.[1])
            .filter(Boolean);
          const upstreamQuery = [...new Set([cleanQuery, ...storageTerms])].join(' ').trim();
          const citySlug = getOlxCitySlug(criteria.city);
          const searchPath = citySlug
            ? `https://www.olx.ua/uk/${citySlug}/q-${encodeURIComponent(upstreamQuery)}/`
            : `https://www.olx.ua/uk/list/q-${encodeURIComponent(upstreamQuery)}/`;
          targetUrl = searchPath;
        }
        const { items } = await parseOlx(targetUrl, criteria.minPrice, criteria.maxPrice, cleanQuery, criteria.city, { source: 'filter_warmup', userId: req.telegramUser.id, criteria });
        const baselineItems = items.filter(item =>
          locationMatches(item.locationDate, criteria.city) ||
          (!item.locationDate && locationMatchesCardText(item.cardText, criteria.city))
        );
        if (baselineItems.length > 0) {
          const initialSeen = baselineItems.map(item => ({
            filter_id: createdFilter.id,
            ad_link: item.link
          }));
          const { error: warmupInsertError } = await supabase.from('seen_ads').upsert(initialSeen, {
            onConflict: 'filter_id,ad_link',
            ignoreDuplicates: true
          });
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

const searchDiagnosticRateLimits = new Map();
const botStatusRateLimits = new Map();

async function runSearchDiagnostic(rawQuery, adminUserId) {
  const requestId = crypto.randomBytes(6).toString('hex');
  const startedAt = Date.now();
  const at = new Date().toISOString();
  const kyivTime = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date(at));
  try {
    const parsed = parseNaturalLanguageQuery(rawQuery);
    const criteria = normalizeCriteria(parsed.criteria);
    const city = criteria.city || '';
    const storageTerms = [...criteria.includeTerms, ...criteria.anyTerms]
      .map(term => String(term).match(/^(\d{2,4})\s*(?:гб|gb)$/iu)?.[1]).filter(Boolean);
    const upstreamQuery = [...new Set([parsed.query, ...storageTerms])].join(' ').trim();
    const citySlug = city ? getOlxCitySlug(city) : '';
    const searchPath = citySlug
      ? `https://www.olx.ua/uk/${citySlug}/q-${encodeURIComponent(upstreamQuery)}/`
      : `https://www.olx.ua/uk/list/q-${encodeURIComponent(upstreamQuery)}/`;
    const { items: parsedItems, pageTraces, stopReason } = await parseOlx(
      searchPath, criteria.minPrice, criteria.maxPrice, parsed.query, city,
      { source: 'diagnostic', userId: adminUserId, requestId, criteria }
    );
    const cityItems = parsedItems.filter(item =>
      locationMatches(item.locationDate, city) ||
      (!item.locationDate && locationMatchesCardText(item.cardText, city))
    );
    if (storageTerms.length) {
      const candidates = cityItems.filter(item =>
        /(?:iphone|айфон)/iu.test(String(item.title || '')) &&
        applyCriteriaToListing(item, criteria).reason === 'missing_required_term'
      ).slice(0, 5);
      for (const item of candidates) {
        const detailContext = await fetchListingDescription(item.link);
        if (detailContext) item.description = [item.description, detailContext].filter(Boolean).join(' ');
      }
    }
    const funnel = evaluateCriteriaFunnel(cityItems, criteria);
    const results = cityItems.filter(item => {
      const match = applyCriteriaToListing(item, criteria);
      return match.matches || (match.reason === 'missing_required_term' &&
        storageTerms.length > 0 && canUseUnverifiedStorageFallback(item, criteria));
    }).map(item => ({
      title: safeText(item.title, 120), url: sanitizeSearchUrl(item.link),
      price: item.price, capacityUnverified: !applyCriteriaToListing(item, criteria).matches
    }));
    const acceptedLinks = new Set(results.map(item => item.url));
    const cityRejected = parsedItems.filter(item => !cityItems.includes(item)).map(item => ({
      listingKey: hashUserId(item.link, TELEGRAM_WEBHOOK_SECRET), url: sanitizeSearchUrl(item.link),
      stage: 'city', reason: 'city_mismatch', value: safeText(item.locationDate || item.cardText, 100)
    }));
    const criteriaRejected = funnel.rejected.map(entry => ({
      listingKey: hashUserId(entry.item.link, TELEGRAM_WEBHOOK_SECRET),
      url: sanitizeSearchUrl(entry.item.link), stage: entry.stage,
      reason: entry.reason, value: safeText(entry.stage === 'price' ? entry.item.price : entry.item.title, 100)
    }));
    const rejected = compactRejectedCards([...cityRejected, ...criteriaRejected], 40);
    const cards = parsedItems.slice(0, 40).map((item, index) => {
      const inCity = cityItems.includes(item);
      const match = applyCriteriaToListing(item, criteria);
      const url = sanitizeSearchUrl(item.link);
      const accepted = acceptedLinks.has(url);
      const modelText = String(item.title || '');
      const modelMatch = modelText.match(/(?:iphone|айфон|іфон|ифон)\s*\d{1,2}\s*(pro\s*max|про\s*макс|pro|про|plus|плюс|max|макс|mini|міні|мини|\+)?/iu);
      const rawVariant = String(modelMatch?.[1] || '').toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
      const modelVersion = !modelMatch ? 'не визначена' :
        /pro\s*max|про\s*макс/.test(rawVariant) ? 'Pro Max' :
        /^(pro|про)$/.test(rawVariant) ? 'Pro' :
        /^(plus|плюс|\+)$/.test(rawVariant) ? 'Plus' :
        /^(max|макс)$/.test(rawVariant) ? 'Max' :
        /^(mini|міні|мини)$/.test(rawVariant) ? 'Mini' : 'базова';
      const searchable = [item.title, item.cardText, item.description].filter(Boolean).join(' ');
      const memoryMatch = searchable.match(/(?:^|[^\d])(64|128|256|512|1024)\s*(?:gb|гб)(?=$|[^\p{L}])/iu) ||
        (/(?:iphone|айфон)/iu.test(modelText) ? searchable.match(/(?:^|[^\d])(64|128|256|512|1024)(?!\s*(?:ram|озу|оператив))(?!\p{L})(?=$|[^\d])/iu) : null);
      const decision = !inCity ? 'відсів: місто не збігається' :
        accepted ? (results.find(result => result.url === url)?.capacityUnverified
          ? 'прийнята; пам’ять не підтверджена' : 'прийнята') :
        'відсів: ' + (match.reason || 'інший критерій');
      return {
        position: index + 1, title: safeText(item.title, 120),
        price: item.priceText || (item.price ? Number(item.price).toLocaleString('uk-UA') + ' грн' : 'не вказана'),
        city: safeText(item.locationDate || 'не визначено', 80),
        modelVersion,
        memory: memoryMatch ? memoryMatch[1] + ' GB' : 'не визначена',
        decision
      };
    });
    const errors = stopReason === 'http_429' || stopReason === 'timeout' || stopReason === 'upstream_error'
      ? [{ httpStatus: null, code: stopReason, antiBotDetected: stopReason === 'http_429' }]
      : [];
    const response = {
      success: true, requestId, at, kyivTime, source: 'diagnostic', parsedQuery: parsed.query,
      criteria: { model: criteria.modelTerm, memory: storageTerms, condition: criteria.condition,
        city, minPrice: criteria.minPrice, maxPrice: criteria.maxPrice, exclusions: criteria.excludeTerms },
      pages: pageTraces, stopReason,
      funnel: { parsed: parsedItems.length, afterDedup: parsedItems.length,
        afterCardParse: parsedItems.length, recommendationClassification: 'not_instrumented',
        afterCity: cityItems.length, ...funnel.counts,
        final: results.length, capacityUnverified: results.filter(item => item.capacityUnverified).length,
        cityUnverified: cityItems.filter(item => !item.locationDate && locationMatchesCardText(item.cardText, city)).length },
      rejected: { cards: rejected.cards, omitted: rejected.omitted },
      results, cards, cardsOmitted: Math.max(0, parsedItems.length - cards.length), errors
    };
    console.log('[SEARCH_TRACE] ' + JSON.stringify({
      event: 'search_funnel', requestId, source: 'diagnostic', at,
      parsed: parsedItems.length, afterDedup: parsedItems.length, afterCardParse: parsedItems.length,
      afterCity: cityItems.length, criteriaStages: funnel.counts,
      finalCount: results.length, capacityUnverified: results.filter(item => item.capacityUnverified).length,
      rejectedCards: rejected.cards, rejectedCardsOmitted: rejected.omitted,
      durationMs: Date.now() - startedAt
    }));
    return { status: 200, body: response };
  } catch (error) {
    const errorInfo = {
      httpStatus: Number(error.response?.status || 0) || null,
      code: safeText(error.code || 'UPSTREAM_ERROR', 48),
      antiBotDetected: error.code === 'OLX_BLOCKED' || [403, 429].includes(Number(error.response?.status || 0))
    };
    console.error('[SEARCH_TRACE] ' + JSON.stringify({
      event: 'search_diagnostic_error', requestId, source: 'diagnostic', at: new Date().toISOString(),
      code: errorInfo.code, httpStatus: errorInfo.httpStatus, durationMs: Date.now() - startedAt
    }));
    return {
      status: error.code === 'OLX_BLOCKED' ? 503 : 502,
      body: { success: false, requestId, at, kyivTime, stopReason: 'upstream_error',
        pages: [], funnel: {}, cards: [], errors: [errorInfo],
        error: 'Не вдалося виконати діагностичний пошук. Перевірте логи за request-id.' }
    };
  }
}

app.post('/api/admin/search-diagnostics', adminAuthMiddleware, async (req, res) => {
  const rawQuery = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 300) : '';
  if (!rawQuery) return res.status(400).json({ success: false, error: 'Укажіть пошуковий запит' });
  const adminKey = hashUserId(req.adminUser.id, TELEGRAM_WEBHOOK_SECRET) || 'admin';
  if (!consumeRateLimit(searchDiagnosticRateLimits, adminKey)) {
    return res.status(429).json({ success: false, error: 'Діагностика доступна не частіше одного разу на хвилину' });
  }
  const result = await runSearchDiagnostic(rawQuery, req.adminUser.id);
  return res.status(result.status).json(result.body);
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
  try {
    const jarUrl = process.env.MONOBANK_JAR_URL || process.env.MONOBANK_JAR_LINK || '';
    if (!jarUrl || !/^https:\/\/(?:send\.monobank\.ua|jar\.monobank\.ua)\//i.test(jarUrl)) {
      return res.status(503).json({ success: false, error: 'Посилання на Monobank-банку ще не налаштоване.' });
    }
    if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ success: false, error: 'Telegram-підтримка тимчасово недоступна.' });
    const user = req.telegramUser || {};
    const identity = escapeTelegramHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || 'Користувач');
    const username = escapeTelegramHtml(user.username ? '@' + user.username : 'не вказаний');
    const message = [
      '💚 <b>Нове повідомлення про донат у ЗНАЙДЕНО</b>',
      'Користувач повідомив, що зробив внесок у Monobank-банку.',
      '',
      'Ім’я: ' + identity,
      'Username: ' + username,
      'Telegram ID: ' + String(user.id || 'невідомий'),
      '',
      'Перевірте фактичне зарахування коштів у банці. Це повідомлення не підтверджує оплату Premium.'
    ].join('\\n');
    const adminIds = [...new Set(ADMIN_IDS)].filter(id => Number.isSafeInteger(id) && id > 0);
    if (!adminIds.length) return res.status(503).json({ success: false, error: 'Адміністратор не налаштований.' });
    const results = await Promise.all(adminIds.map(id => sendTelegramMessage(id, message)));
    if (!results.some(Boolean)) return res.status(502).json({ success: false, error: 'Не вдалося доставити повідомлення адміністратору. Спробуйте пізніше.' });
    return res.json({ success: true, notified: results.filter(Boolean).length });
  } catch (error) {
    console.error('[Donation notice] Не вдалося повідомити адміністратора:', error.message);
    return res.status(500).json({ success: false, error: 'Не вдалося надіслати повідомлення адміністратору.' });
  }
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

      const firstStartPayload = text.startsWith('/start') ? text.trim().split(/\s+/, 2)[1] || '' : '';
      const firstReferralMatch = /^ref_(\d{1,20})$/.exec(firstStartPayload);
      const inviterCandidate = firstReferralMatch ? Number(firstReferralMatch[1]) : 0;
      const inviteeCandidate = Number(chatId);
      const pendingReferrer = isNewTelegramUser &&
        Number.isSafeInteger(inviterCandidate) && inviterCandidate > 0 &&
        Number.isSafeInteger(inviteeCandidate) && inviteeCandidate > 0 &&
        inviterCandidate !== inviteeCandidate
          ? inviterCandidate
          : null;

      const userPayload = {
        telegram_id: chatId,
        first_name: msg.from?.first_name || 'User',
        telegram_blocked_at: null,
        ...(isNewTelegramUser ? { trial_started_at: new Date().toISOString() } : {}),
        ...(pendingReferrer ? { pending_referrer_telegram_id: pendingReferrer } : {})
      };
      const { error: userUpsertError } = await userDb.from('users').upsert(userPayload, { onConflict: 'telegram_id' });
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
    // Referral attribution is persisted on the invitee's first start and retried
    // on later /start updates if the atomic database operation previously failed.
    const referralDb = supabaseAdmin || supabase;
    if (referralDb) {
      const inviteeId = Number(chatId);
      const { data: pendingReferralUser, error: pendingReferralError } = await referralDb
        .from('users')
        .select('pending_referrer_telegram_id')
        .eq('telegram_id', inviteeId)
        .maybeSingle();
      if (pendingReferralError) {
        console.warn('Не вдалося прочитати відкладене реферальне запрошення:', pendingReferralError.message);
      } else if (pendingReferralUser?.pending_referrer_telegram_id) {
        const inviterId = Number(pendingReferralUser.pending_referrer_telegram_id);
        const { data: rewardData, error: rewardError } = await referralDb.rpc('grant_referral_reward', {
          p_inviter_telegram_id: inviterId,
          p_invitee_telegram_id: inviteeId
        });
        if (rewardError) {
          console.warn('Не вдалося атомарно обробити реферальне запрошення; воно залишиться для повторної спроби:', rewardError.message);
        } else {
          const rewardResult = Array.isArray(rewardData) ? rewardData[0] : rewardData;
          if (rewardResult?.rewarded === true) {
            console.log('[Referral] Premium bonus atomically granted for invitee:', inviteeId);
          } else if (rewardResult?.reason) {
            console.log('[Referral] Attribution result:', rewardResult.reason);
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

const WORKER_INSTANCE_ID = process.env.RENDER_INSTANCE_ID || crypto.randomUUID();
let isWorkerRunning = false;
async function runBackgroundWorker() {
  if (isWorkerRunning || !supabase || !TELEGRAM_BOT_TOKEN) return;

  try {
    isWorkerRunning = true;
    const { data: filters, error: filtersError } = await supabase.from('filters').select('*').order('created_at', { ascending: true });
    const processedFiltersByUser = new Map();
    if (filtersError) throw filtersError;
    if (!filters || filters.length === 0) return;

    for (const filter of filters) {
      const lockClient = supabaseAdmin || supabase;
      let filterLockAcquired = false;
      try {
        if (!lockClient) continue;
        const { data: lockAcquired, error: lockError } = await lockClient.rpc('acquire_filter_processing_lock', {
          p_filter_id: String(filter.id),
          p_lock_owner: WORKER_INSTANCE_ID,
          p_lease_seconds: 600
        });
        if (lockError) {
          console.warn(`[Worker Lock] Не вдалося захопити фільтр ${filter.id}; пропускаємо цей цикл:`, lockError.message);
          continue;
        }
        filterLockAcquired = lockAcquired === true;
        if (!filterLockAcquired) continue;

        const { data: filterOwner, error: ownerError } = await supabase
          .from('users').select('tariff,premium_until,is_admin,trial_started_at,telegram_blocked_at').eq('telegram_id', filter.user_id).maybeSingle();
        if (ownerError) {
          console.error(`Не вдалося перевірити тариф користувача для фільтра ${filter.id}:`, ownerError.message);
          continue;
        }
        if (filterOwner?.telegram_blocked_at) {
          console.log(`[Worker] Користувач ${filter.user_id} заблокував бота; фільтр ${filter.id} пропущено.`);
          continue;
        }
        const access = deriveAccess(filterOwner || {}, filterOwner?.is_admin === true);
        const userKey = String(filter.user_id);
        const processedCount = processedFiltersByUser.get(userKey) || 0;
        const filterLimit = filterOwner?.is_admin === true
          ? Infinity
          : Math.max(1, Number(access.filterLimit) || 1);
        if (processedCount >= filterLimit) continue;
        processedFiltersByUser.set(userKey, processedCount + 1);
        const intervalMs = access.checkIntervalMinutes * 60 * 1000;
        const lastCheckedAt = filter.last_checked_at ? Date.parse(filter.last_checked_at) : 0;
        if (Number.isFinite(lastCheckedAt) && lastCheckedAt > 0 && Date.now() - lastCheckedAt < intervalMs) continue;

        const storedQuery = filter.query ? String(filter.query).trim() : '';
        const parsedStoredQuery = /^https?:\/\//i.test(storedQuery) ? null : parseNaturalLanguageQuery(storedQuery);
        const criteria = normalizeCriteria({
          ...(parsedStoredQuery?.criteria || {}),
          ...(filter.criteria || {}),
          minPrice: filter.min_price,
          maxPrice: filter.max_price,
          city: filter.city,
          condition: filter.condition
        });
        let targetUrl = parsedStoredQuery?.query || storedQuery;

        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          const storageQueryTerms = [...criteria.includeTerms, ...criteria.anyTerms]
            .map(term => String(term).match(/^(\d{2,4})\s*(?:гб|gb)$/iu)?.[1])
            .filter(Boolean);
          const upstreamQuery = [...new Set([targetUrl, ...storageQueryTerms])].join(' ').trim();
          const citySlug = getOlxCitySlug(filter.city);
          const searchPath = citySlug
            ? `https://www.olx.ua/uk/${citySlug}/q-${encodeURIComponent(upstreamQuery)}/`
            : `https://www.olx.ua/uk/list/q-${encodeURIComponent(upstreamQuery)}/`;
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

        const { items: parsedItems, averagePrice, requestId: searchRequestId } = await parseOlx(targetUrl, filter.min_price, filter.max_price, filter.query, filter.city, { source: 'background', userId: filter.user_id, criteria });
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
        const locationEligibleItems = dateEligibleItems.filter(item =>
          locationMatches(item.locationDate, requestedLocation) ||
          (!item.locationDate && locationMatchesCardText(item.cardText, requestedLocation))
        );
        const dateRejected = parsedItems.filter(item => !dateEligibleItems.includes(item));
        const cityRejected = dateEligibleItems.filter(item => !locationEligibleItems.includes(item));
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
        const storageRequirements = [...criteria.includeTerms, ...criteria.anyTerms]
          .filter(term => /^\d{2,4}\s*(?:гб|gb)$/iu.test(term));
        const criteriaEvaluations = locationEligibleItems.map(item => {
          // If the detail page could not be read, don't claim the item passed
          // explicit required/excluded-word rules using incomplete card text.
          if (needsFullDescription && !item.detailsLoaded) {
            return { item, matches: false, reason: 'description_unavailable' };
          }
          const listing = {
            ...item,
            ageMinutes: getListingAgeMinutes(item.locationDate)
          };
          const result = applyCriteriaToListing(listing, criteria);
          if (result.matches) return { item, matches: true, reason: 'matched' };

          // Mirror Smart Search's safe capacity fallback: the requested
          // capacity was sent to OLX, no conflicting capacity is visible,
          // and the user is explicitly told that the card did not confirm it.
          if (result.reason === 'missing_required_term' &&
              storageRequirements.length &&
              canUseUnverifiedStorageFallback(listing, criteria)) {
            item.capacityUnverified = true;
            item.capacityVerificationNote = 'Обсяг пам’яті не вказаний у картці OLX — перевірте його в оголошенні.';
            return { item, matches: true, reason: 'capacity_unverified' };
          }
          return { item, matches: false, reason: result.reason || 'criteria_mismatch' };
        });
        const items = criteriaEvaluations.filter(result => result.matches).map(result => result.item);
        const rejectionCounts = criteriaEvaluations.reduce((counts, result) => {
          if (!result.matches) counts[result.reason] = (counts[result.reason] || 0) + 1;
          return counts;
        }, {});
        const traceRejected = [
          ...dateRejected.map(item => ({ item, stage: 'date', reason: 'not_published_today_or_seen' })),
          ...cityRejected.map(item => ({ item, stage: 'city', reason: 'city_mismatch' })),
          ...criteriaEvaluations.filter(result => !result.matches).map(result => ({
            item: result.item, stage: result.reason === 'condition_mismatch' ? 'condition' :
              (result.reason === 'below_min_price' || result.reason === 'above_max_price' ? 'price' :
                (result.reason === 'missing_required_term' ? 'memory_or_required_terms' :
                  (result.reason === 'model_mismatch' || result.reason === 'wrong_product_type' ? 'model' : 'other'))),
            reason: result.reason
          }))
        ].map(entry => ({
          listingKey: hashUserId(entry.item.link, TELEGRAM_WEBHOOK_SECRET),
          url: sanitizeSearchUrl(entry.item.link), stage: entry.stage, reason: entry.reason,
          value: safeText(entry.stage === 'city' ? entry.item.locationDate : entry.item.title, 100)
        }));
        console.log('[SEARCH_TRACE] ' + JSON.stringify({
          event: 'search_funnel', requestId: searchRequestId, source: 'background', at: new Date().toISOString(),
          parsed: parsedItems.length, afterDedup: parsedItems.length, afterCardParse: parsedItems.length,
          afterDate: dateEligibleItems.length, afterCity: locationEligibleItems.length,
          afterCriteria: items.length,
          capacityUnverified: items.filter(item => item.capacityUnverified === true).length,
          cityUnverified: locationEligibleItems.filter(item => !item.locationDate).length,
          rejectedByReason: rejectionCounts,
          rejectedCards: compactRejectedCards(traceRejected, 25).cards,
          rejectedCardsOmitted: compactRejectedCards(traceRejected, 25).omitted,
          knownListings: knownLinks.size
        }));
        console.log(`[Worker Diagnostics] filter=${filter.id} requestId=${searchRequestId} parsed=${parsedItems.length} dateEligible=${dateEligibleItems.length} locationEligible=${locationEligibleItems.length} criteriaEligible=${items.length} rejected=${JSON.stringify(rejectionCounts)} known=${knownLinks.size} city="${requestedLocation}" sampleLocations=${JSON.stringify(parsedItems.slice(0, 5).map(item => String(item.locationDate || '').slice(0, 100)))}`);
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

          const safeFilterQuery = escapeTelegramHtml(filter.query);
          const safeTitle = escapeTelegramHtml(item.title);
          const safeLocation = escapeTelegramHtml(item.locationDate);
          const safeItemLink = escapeTelegramHtml(item.link);
          const capacityWarning = item.capacityUnverified
            ? '\n⚠️ <b>' + escapeTelegramHtml(item.capacityVerificationNote || 'Обсяг пам’яті не підтверджено — перевірте характеристики в оголошенні.') + '</b>\n'
            : '';
          const notificationText =
            (hasPriceDrop
              ? `📉 <b>Ціна знизилася для оголошення у фільтрі “${safeFilterQuery}”</b>\n\n<b>Було:</b> ${previousPrice.toLocaleString('uk-UA')} грн → <b>Стало:</b> ${Number(item.price).toLocaleString('uk-UA')} грн\n\n`
              : `🔎 <b>Знайдено нове оголошення для фільтра “${safeFilterQuery}”</b>\n\n`) +
            `📌 <b>${safeTitle}</b>\n` +
            `💰 <b>Ціна:</b> ${item.priceText} ${isCheap ? `🔥 (Нижче медіани на ${discount}%)` : ''}\n` +
            (isCheap && bargain.reliable
              ? `📊 <b>Медіана аналогів:</b> ${Number(bargain.referencePrice).toLocaleString('uk-UA')} грн • ${bargain.comparableCount} оголошень\n`
              : '') +
            `📍 <b>Місто:</b> ${safeLocation}\n\n` +
            capacityWarning +
            `<a href="${safeItemLink}">👉 Відкрити оголошення на OLX</a>`;

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
      } finally {
        if (filterLockAcquired && lockClient) {
          try {
            const { error: releaseError } = await lockClient.rpc('release_filter_processing_lock', {
              p_filter_id: String(filter.id),
              p_lock_owner: WORKER_INSTANCE_ID
            });
            if (releaseError) console.warn(`[Worker Lock] Не вдалося звільнити фільтр ${filter.id}:`, releaseError.message);
          } catch (releaseError) {
            console.warn(`[Worker Lock] Помилка звільнення фільтра ${filter.id}:`, releaseError.message);
          }
        }
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