const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

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
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const SERVER_URL = (process.env.SERVER_URL || 'https://olx-checker-backend.onrender.com').replace(/\/$/, '');

const ADMIN_IDS = (process.env.ADMIN_IDS || '668277478')
  .split(',')
  .map(id => parseInt(id.trim(), 10))
  .filter(Boolean);

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`✅ Supabase підключено: ${SUPABASE_URL}`);
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

function locationMatches(locationDate, requestedLocation) {
  const requested = String(requestedLocation || '').trim().toLocaleLowerCase('uk-UA');
  if (!requested || requested === 'всі міста' || requested === 'вся україна' || requested === 'уся україна') return true;
  const actual = String(locationDate || '').toLocaleLowerCase('uk-UA');
  // OLX cards usually expose the city in their location/date label. Match the
  // requested place only against that label; never pretend a broad search is local.
  return actual.includes(requested);
}

async function parseOlx(targetUrl, minPrice, maxPrice, query = '') {
  const response = await axios.get(targetUrl, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(response.data);
  const rawItems = [];

  const stopWords = [
    'аккумулятор', 'акумулятор', 'батарея', 'корпус', 'шлейф', 'плата', 'камера', 'динамик',
    'стекло', 'скло', 'чехол', 'чохол', 'накладка', 'бампер', 'дисплей', 'экран', 'екран',
    'коробка', 'кабель', 'зарядка', 'адаптер', 'ремешок', 'пленка', 'запчасти', 'разборка',
    'icloud', 'lost', 'passcode', 'пароль', 'bypass', 'донор', 'скупка', 'ремонт', 'копия', 'реплика'
  ];

  // OLX periodically changes card attributes. Support both current and older
  // card markup, and only use article fallback when it contains an ad link.
  let cards = $('[data-cy="l-card"], [data-testid="l-card"]');
  if (!cards.length) {
    cards = $('article').filter((_, el) =>
      $(el).find('a[href*="/d/"], a[href*="/obyavlenie/"]').length > 0
    );
  }
  if (!cards.length) {
    cards = $('[data-testid="listing-grid"] > div, [data-cy="listing-grid"] > div').filter((_, el) =>
      $(el).find('a[href*="/d/"], a[href*="/obyavlenie/"]').length > 0
    );
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
    const dataSrc = imgEl.attr('data-src') || '';
    const srcset = imgEl.attr('srcset') || imgEl.attr('data-srcset') || '';

    let candidate = '';
    if (dataSrc && !dataSrc.startsWith('data:')) candidate = dataSrc;
    else if (srcset && !srcset.startsWith('data:')) candidate = srcset.split(',')[0].trim().split(' ')[0];
    else if (src && !src.startsWith('data:')) candidate = src;

    if (candidate) {
      candidate = candidate.replace(/\\/g, '').replace(/&amp;/g, '&');
      if (candidate.startsWith('//')) candidate = 'https:' + candidate;
      else if (candidate.startsWith('/')) candidate = 'https://www.olx.ua' + candidate;
      rawImgUrl = candidate;
    }

    const locationDate = $(element).find('[data-testid="location-date"], [data-cy="location-date"], [class*="location"], [class*="date"]').first().text().trim();
    const descriptionCandidate = $(element).find(
      '[data-testid="ad-description"], [data-cy="ad-description"], [class*="description"], p'
    ).first().text().replace(/\\s+/g, ' ').trim();
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

  const prices = rawItems.map(i => i.price).sort((a, b) => a - b);
  let averagePrice = 0;

  if (prices.length > 0) {
    const medianPrice = prices[Math.floor(prices.length / 2)];
    const filteredPrices = prices.filter(p => p >= medianPrice * 0.5 && p <= medianPrice * 2.0);
    const sum = filteredPrices.reduce((a, b) => a + b, 0);
    averagePrice = filteredPrices.length > 0 ? Math.round(sum / filteredPrices.length) : medianPrice;
  }

  return { items: rawItems, averagePrice };
}

app.get('/api/search', async (req, res) => {
  try {
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
    if (requestedCondition === 'new') {
      items = items.filter(item => /\b(нове|новый|новая|новое|нові|новые|новая річ|новий товар)\b/i.test(`${item.title} ${item.description || ''}`));
    } else if (requestedCondition === 'used') {
      items = items.filter(item => /\b(б\/у|бу|вживан|уживан|після використання|used)\b/i.test(`${item.title} ${item.description || ''}`));
    }
    res.json({ success: true, count: items.length, averagePrice, items });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Помилка отримання даних з OLX' });
  }
});

app.get('/api/user/profile', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    const isAdmin = await checkIsAdmin(userId);
    let userData = { tariff: 'free', premium_until: null };

    if (supabase) {
      const { data, error } = await supabase.from('users').select('*').eq('telegram_id', userId).maybeSingle();
      if (error) throw error;
      if (data) {
        userData = data;
      } else {
        const { error: upsertError } = await supabase.from('users').upsert({
          telegram_id: userId, first_name: req.telegramUser.first_name || 'User', is_admin: isAdmin
        }, { onConflict: 'telegram_id' });
        if (upsertError) throw upsertError;
      }
    }

    const hasActivePremium = isAdmin || (
      userData.tariff === 'premium' &&
      Boolean(userData.premium_until) &&
      Number.isFinite(Date.parse(userData.premium_until)) &&
      Date.parse(userData.premium_until) > Date.now()
    );
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
    const userId = req.telegramUser.id;
    const { query, minPrice, maxPrice, city, condition } = req.body;

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
      const { data: userData, error: userError } = await supabase.from('users').select('tariff,premium_until').eq('telegram_id', userId).maybeSingle();
      if (userError) throw userError;
      const isPremium = isAdmin || Boolean(userData && userData.tariff === 'premium' &&
        userData.premium_until && Date.parse(userData.premium_until) > Date.now());
      if (!isPremium && uniqueQueries.size >= 1) {
        return res.status(403).json({ success: false, error: 'LIMIT_EXCEEDED' });
      }

      const { data, error } = await supabase.from('filters').insert([{
        user_id: userId,
        query: cleanQuery,
        min_price: parseInt(minPrice, 10) || 0,
        max_price: parseInt(maxPrice, 10) || 0,
        city: city ? city.trim() : 'Всі міста',
        condition: condition || 'all'
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
    title: "Публічна оферта та Умови використання OLX Checker",
    content: "Дана Оферта є офіційною пропозицією сервісу OLX Checker для фізичних осіб щодо надання доступу до функцій автоматичного моніторингу оголошень. Оплата послуг або використання Telegram Mini App означає повне прийняття цих умов."
  });
});

app.get('/api/legal/privacy', (req, res) => {
  res.json({
    title: "Політика конфіденційності",
    content: "Сервіс OLX Checker обробляє тільки публічні дані Telegram (ID, ім'я) та збережені параметри фільтрів. Платіжні дані обробляються виключно ліцензованими провайдерами (Monobank / Telegram Stars)."
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
          await sendTelegramMessage(chatId, 'Знайшли незавершену активацію платежу та відновили Premium на 30 днів. Дякуємо за підтримку OLX Checker.');
        } else {
          await sendTelegramMessage(chatId, 'Цей платіж уже оброблено, Premium активний. Дякуємо за підтримку OLX Checker.');
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
      await sendTelegramMessage(chatId, 'Оплату Telegram Stars підтверджено! Premium активовано на 30 днів. Дякуємо за підтримку OLX Checker.');
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
    const startPayload = text.trim().split(/\\s+/, 2)[1] || '';
    if (startPayload === 'buy_premium') {
      const starsPrice = Number(process.env.TELEGRAM_STARS_PREMIUM_PRICE || 100);
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendInvoice`, {
          chat_id: chatId,
          title: 'OLX Checker Premium — 30 днів',
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
    if (referralMatch && supabase) {
      const inviterId = Number(referralMatch[1]);
      const inviteeId = Number(chatId);
      if (Number.isSafeInteger(inviterId) && inviterId > 0 &&
          Number.isSafeInteger(inviteeId) && inviteeId > 0 && inviterId !== inviteeId) {
        const { data: newReferral, error: referralError } = await supabase.from('referrals').upsert({
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
      `👋 <b>Ласкаво просимо до OLX Checker 1.0.0!</b>\n\n` +
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
      inline_keyboard: [[{ text: '🚀 Відкрити OLX Checker', web_app: { url: SERVER_URL } }]]
    };
    await sendTelegramMessage(chatId, welcomeText, keyboard);
    return;
  }

  if (text.startsWith('/paysupport') || text.startsWith('/support')) {
    await sendTelegramMessage(chatId,
      'Підтримка платежів OLX Checker. Опишіть проблему та, якщо є, дату платежу. Контакт: ivanleonenko2016@gmail.com. Не надсилайте дані банківської картки чи паролі.');
    return;
  }

  if (text.startsWith('/terms')) {
    await sendTelegramMessage(chatId,
      'Умови OLX Checker: Premium надає доступ до додаткових функцій моніторингу на 30 днів після підтвердження платежу. Сервіс незалежний від OLX і не гарантує безперервну роботу стороннього сайту. Питання щодо платежів: ivanleonenko2016@gmail.com. Повні юридичні дані постачальника та остаточні умови потрібно опублікувати до публічного запуску.');
    return;
  }

  if (text.startsWith('/admin')) {
    const isAdmin = await checkIsAdmin(chatId);
    if (!isAdmin) {
      await sendTelegramMessage(chatId, `❌ У доступі відмовлено.`);
      return;
    }
    const keyboard = {
      inline_keyboard: [[{ text: '🛠 Відкрити Адмін-Панель', web_app: { url: SERVER_URL } }]]
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
          .from('users').select('tariff,premium_until,is_admin').eq('telegram_id', filter.user_id).maybeSingle();
        if (ownerError) {
          console.error(`Не вдалося перевірити тариф користувача для фільтра ${filter.id}:`, ownerError.message);
          continue;
        }
        const ownerPremium = Boolean(filterOwner && (
          filterOwner.is_admin === true ||
          (filterOwner.tariff === 'premium' && filterOwner.premium_until &&
            Number.isFinite(Date.parse(filterOwner.premium_until)) && Date.parse(filterOwner.premium_until) > Date.now())
        ));
        const intervalMs = (ownerPremium ? 2 : 15) * 60 * 1000;
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
        const requestedLocation = String(filter.city || '').trim();
        const items = parsedItems.filter(item => locationMatches(item.locationDate, requestedLocation));
        if (requestedLocation && !['всі міста', 'вся україна', 'уся україна'].includes(requestedLocation.toLocaleLowerCase('uk-UA')) && parsedItems.length > 0 && items.length === 0) {
          console.log(`[Location Filter] Для фільтра ${filter.id} не знайдено карток із локацією "${requestedLocation}" серед ${parsedItems.length} результатів OLX.`);
        }
        const { error: checkedAtError } = await supabase.from('filters')
          .update({ last_checked_at: new Date().toISOString() }).eq('id', filter.id);
        if (checkedAtError) {
          console.error(`Не вдалося оновити час перевірки фільтра ${filter.id}:`, checkedAtError.message);
        }

        if (!items || items.length === 0) continue;

        // Skip links already seen for this filter before attempting an insert.
        const { data: knownRows, error: knownError } = await supabase
          .from('seen_ads').select('ad_link').eq('filter_id', filter.id);
        if (knownError) {
          console.error(`Не вдалося перевірити seen_ads для фільтра ${filter.id}:`, knownError.message);
          continue;
        }
        const knownLinks = new Set((knownRows || []).map(row => String(row.ad_link || '').trim().replace(/\/$/, '')));
        for (const item of items) {
          const canonicalLink = String(item.link || '').trim().replace(/\/$/, '');
          if (!canonicalLink || knownLinks.has(canonicalLink)) continue;

          const isCheap = averagePrice > 0 && item.price < averagePrice * 0.85;
          const discount = isCheap ? Math.round((1 - item.price / averagePrice) * 100) : 0;

          const notificationText = 
            `🔎 <b>Знайдено нове оголошення для фільтра “${filter.query}”</b>\n\n` +
            `📌 <b>${item.title}</b>\n` +
            `💰 <b>Ціна:</b> ${item.priceText} ${isCheap ? `🔥 (Нижче ринку на ${discount}%)` : ''}\n` +
            `📍 <b>Місто:</b> ${item.locationDate}\n\n` +
            `<a href="${item.link}">👉 Відкрити оголошення на OLX</a>`;

          const keyboard = {
            inline_keyboard: [
              [{ text: '👉 Переглянути оголошення', url: item.link }],
              [{ text: '🚀 Відкрити OLX Checker', web_app: { url: SERVER_URL } }]
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
            } else {
              knownLinks.add(canonicalLink);
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

setInterval(runBackgroundWorker, 60000);

async function registerWebhook() {
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
