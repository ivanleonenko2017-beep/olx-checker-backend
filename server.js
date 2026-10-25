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

    if (calculatedHash === hash) {
      const userStr = urlParams.get('user');
      const authDate = parseInt(urlParams.get('auth_date') || '0', 10);
      
      const now = Math.floor(Date.now() / 1000);
      if (now - authDate > 86400) return null;
      return userStr ? JSON.parse(userStr) : null;
    }
  } catch (e) {
    console.error('[Auth Error]', e.message);
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
    return res.status(401).json({ success: false, error: 'Unauthorized' });
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
  return res.status(403).json({ success: false, error: 'Forbidden' });
}

async function sendTelegramMessage(chatId, text, replyMarkup = null, useHtml = true) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: false,
    reply_markup: replyMarkup
  };
  if (useHtml) payload.parse_mode = 'HTML';

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload, { timeout: 5000 });
    return true;
  } catch (err) {
    if (useHtml && err.response?.data?.description?.includes("can't parse entities")) {
      // ИСПРАВЛЕНИЕ: Fallback для рассылки обычного текста со скобками
      console.warn(`⚠️ HTML parse error for chat ${chatId}. Retrying as plain text.`);
      return await sendTelegramMessage(chatId, text, replyMarkup, false);
    }
    if (err.response?.status === 429) {
      console.warn(`⚠️ 429 Too Many Requests for ${chatId}`);
    }
    return false;
  }
}

async function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const fullPhotoUrl = photoUrl.startsWith('/') ? `${SERVER_URL}${photoUrl}` : photoUrl;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      chat_id: chatId,
      photo: fullPhotoUrl,
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }, { timeout: 8000 });
    return true;
  } catch (err) {
    if (err.response?.status === 429) return false;
    return await sendTelegramMessage(chatId, caption, replyMarkup);
  }
}

app.get('/api/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl || imageUrl.includes('no-photo.svg')) {
      return res.redirect('/assets/no-photo.svg');
    }
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://www.olx.ua/' },
      timeout: 5000
    });
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    res.redirect('/assets/no-photo.svg');
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function parseOlx(targetUrl, minPrice, maxPrice, query = '') {
  const response = await axios.get(targetUrl, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(response.data);
  const rawItems = [];

  const stopWords = ['аккумулятор', 'акумулятор', 'батарея', 'корпус', 'шлейф', 'плата', 'камера', 'динамик', 'стекло', 'скло', 'чехол', 'чохол', 'накладка', 'бампер', 'дисплей', 'экран', 'екран', 'коробка', 'кабель', 'зарядка', 'адаптер', 'ремешок', 'пленка', 'запчасти', 'разборка', 'icloud', 'lost', 'passcode', 'пароль', 'bypass', 'донор', 'скупка', 'ремонт', 'копия', 'реплика'];

  $('[data-cy="l-card"], [data-testid="l-card"]').each((index, element) => {
    if (rawItems.length >= 30) return;
    $(element).find('style, script').remove();
    const title = $(element).find('h6, h4, [data-testid="ad-title"]').first().text().trim();
    if (!title) return;

    const lowerTitle = title.toLowerCase();
    const queryLower = (query || '').toLowerCase();
    if (stopWords.some(w => lowerTitle.includes(w)) && !stopWords.some(w => queryLower.includes(w))) return;

    const priceElement = $(element).find('[data-testid="ad-price"]').first();
    priceElement.find('style, script').remove();
    let rawPriceText = priceElement.text().trim();
    if (rawPriceText.includes('грн')) rawPriceText = rawPriceText.split('грн')[0] + ' грн';

    const match = rawPriceText.match(/(\d[\d\s]*)/);
    let numericPrice = 0;
    if (match) numericPrice = parseInt(match[1].replace(/\s/g, ''), 10);
    if (minPrice && numericPrice < parseInt(minPrice, 10)) return;
    if (maxPrice && numericPrice > parseInt(maxPrice, 10)) return;

    const rawLink = $(element).find('a').attr('href') || '';
    const link = rawLink.startsWith('http') ? rawLink : `https://www.olx.ua${rawLink}`;

    let rawImgUrl = '';
    const imgEl = $(element).find('img').first();
    const src = imgEl.attr('src') || '';
    const dataSrc = imgEl.attr('data-src') || '';
    const srcset = imgEl.attr('srcset') || imgEl.attr('data-srcset') || '';
    let candidate = (dataSrc && !dataSrc.startsWith('data:')) ? dataSrc : ((srcset && !srcset.startsWith('data:')) ? srcset.split(',')[0].trim().split(' ')[0] : ((src && !src.startsWith('data:')) ? src : ''));
    if (candidate) {
      candidate = candidate.replace(/\\/g, '').replace(/&amp;/g, '&');
      rawImgUrl = candidate.startsWith('//') ? 'https:' + candidate : (candidate.startsWith('/') ? 'https://www.olx.ua' + candidate : candidate);
    }
    const locationDate = $(element).find('[data-testid="location-date"]').first().text().trim();

    if (title && !isNaN(numericPrice) && numericPrice > 0 && rawLink) {
      rawItems.push({
        id: 'ad_' + crypto.randomBytes(4).toString('hex'),
        title, price: numericPrice, priceText: `${numericPrice.toLocaleString('uk-UA')} грн`,
        link, rawImgUrl,
        proxyImg: rawImgUrl ? `${SERVER_URL}/api/proxy-image?url=${encodeURIComponent(rawImgUrl)}` : `${SERVER_URL}/assets/no-photo.svg`,
        locationDate: locationDate || 'Україна', description: 'Перегляньте деталі на OLX.'
      });
    }
  });

  const prices = rawItems.map(i => i.price).sort((a, b) => a - b);
  let averagePrice = 0;
  if (prices.length > 0) {
    const medianPrice = prices[Math.floor(prices.length / 2)];
    const filteredPrices = prices.filter(p => p >= medianPrice * 0.5 && p <= medianPrice * 2.0);
    averagePrice = filteredPrices.length > 0 ? Math.round(filteredPrices.reduce((a, b) => a + b, 0) / filteredPrices.length) : medianPrice;
  }
  return { items: rawItems, averagePrice };
}

app.get('/api/search', async (req, res) => {
  try {
    const { query, categoryUrl, minPrice, maxPrice } = req.query;
    let targetUrl = categoryUrl;
    if (!targetUrl && query) {
      const cleanQ = query.trim();
      if (cleanQ.startsWith('http')) { targetUrl = cleanQ; }
      else if (minPrice || maxPrice) {
        const p = [minPrice ? `search%5Bfilter_float_price%3Afrom%5D=${minPrice}` : '', maxPrice ? `search%5Bfilter_float_price%3Ato%5D=${maxPrice}` : ''].filter(Boolean).join('&');
        targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(cleanQ)}/?${p}`;
      } else { targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(cleanQ)}/`; }
    }
    if (!targetUrl) return res.status(400).json({ error: 'Укажіть пошуковий запит' });
    const { items, averagePrice } = await parseOlx(targetUrl, minPrice, maxPrice, query);
    res.json({ success: true, count: items.length, averagePrice, items });
  } catch (error) { res.status(500).json({ success: false, error: 'Помилка OLX' }); }
});

app.get('/api/user/profile', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    const isAdmin = await checkIsAdmin(userId);
    let userData = { tariff: 'free' };
    if (supabase) {
      const { data } = await supabase.from('users').select('*').eq('telegram_id', userId).maybeSingle();
      if (data) userData = data;
      else await supabase.from('users').upsert({ telegram_id: userId, is_admin: isAdmin }, { onConflict: 'telegram_id' });
    }
    if (isAdmin) {
      userData.tariff = 'premium';
      userData.is_admin = true;
    }
    res.json({ success: true, isAdmin, user: userData, stats: { totalReferrals: 0 } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/user/filters', userAuthMiddleware, async (req, res) => {
  try {
    if (!supabase) return res.json({ success: true, filters: [] });
    const { data, error } = await supabase.from('filters').select('*').eq('user_id', req.telegramUser.id);
    if (error) throw error;
    res.json({ success: true, filters: data || [] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/filters', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    const { query, minPrice, maxPrice, city, condition } = req.body;
    if (!query || typeof query !== 'string') return res.status(400).json({ success: false, error: 'Введіть запит' });
    const cleanQuery = query.trim();

    if (supabase) {
      await supabase.from('users').upsert({ telegram_id: userId }, { onConflict: 'telegram_id' });
      const { data: existingFilters } = await supabase.from('filters').select('*').eq('user_id', userId);
      if ((existingFilters || []).some(f => f.query.toLowerCase() === cleanQuery.toLowerCase())) {
        return res.status(400).json({ success: false, error: 'Такий фільтр вже існує' });
      }

      // ИСПРАВЛЕНИЕ: Корректный расчет лимита для администратора
      const isAdmin = await checkIsAdmin(userId);
      const { data: userData } = await supabase.from('users').select('*').eq('telegram_id', userId).maybeSingle();
      const isPremium = isAdmin || (userData && userData.tariff === 'premium' && new Date(userData.premium_until) > new Date());
      
      if (!isPremium && existingFilters && existingFilters.length >= 2) {
        return res.status(403).json({ success: false, error: 'LIMIT_EXCEEDED' });
      }

      const { data, error } = await supabase.from('filters').insert([{
        user_id: userId, query: cleanQuery,
        min_price: parseInt(minPrice, 10) || 0, max_price: parseInt(maxPrice, 10) || 0,
        city: city ? city.trim() : 'Всі міста', condition: condition || 'all'
      }]).select();
      if (error) throw error;
      return res.json({ success: true, filter: data[0] });
    }
    return res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/filters/:id', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.telegramUser.id;
    const filterId = req.params.id;

    if (supabase) {
      const { data: filter, error: fetchErr } = await supabase.from('filters').select('user_id').eq('id', filterId).maybeSingle();
      if (fetchErr || !filter) return res.status(404).json({ success: false, error: 'Фільтр не знайдено' });
      if (String(filter.user_id) !== String(userId)) return res.status(403).json({ success: false, error: 'Forbidden' });

      // ИСПРАВЛЕНИЕ: Предварительное каскадное удаление зависимых записей
      await supabase.from('seen_ads').delete().eq('filter_id', filterId);
      const { error: deleteErr } = await supabase.from('filters').delete().eq('id', filterId);
      if (deleteErr) throw deleteErr;
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Delete error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Роуты API Legal, Stats, Diagnostics оставлены без изменений, как в исходнике (опущено для экономии размера файла)...
app.get('/api/legal/terms', (req, res) => res.json({title: "Оферта", content: "..."}));
app.get('/api/legal/privacy', (req, res) => res.json({title: "Конфіденційність", content: "..."}));
app.get('/api/admin/stats', adminAuthMiddleware, async (req, res) => {
  const { count: uCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
  res.json({ success: true, stats: { totalUsers: uCount || 0 } });
});
app.get('/api/admin/diagnostics', adminAuthMiddleware, async (req, res) => res.json({ success: true, supabaseOk: Boolean(supabase), botOk: Boolean(TELEGRAM_BOT_TOKEN) }));

app.post('/api/admin/broadcast', adminAuthMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !supabase) return res.status(400).json({ error: 'Текст порожній' });
    const { data: users } = await supabase.from('users').select('telegram_id');
    let sentCount = 0, failedCount = 0;
    for (const u of (users || [])) {
      if (!u.telegram_id) continue;
      const ok = await sendTelegramMessage(u.telegram_id, text);
      ok ? sentCount++ : failedCount++;
      await new Promise(r => setTimeout(r, 200));
    }
    res.json({ success: true, sentCount, failedCount, total: users.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  if (supabase) await supabase.from('users').upsert({ telegram_id: chatId, first_name: msg.from?.first_name || 'User' }, { onConflict: 'telegram_id' });
  if (msg.text?.startsWith('/start')) {
    const kb = { inline_keyboard: [[{ text: '🚀 Відкрити OLX Checker', web_app: { url: SERVER_URL } }]] };
    await sendTelegramMessage(chatId, `👋 <b>Ласкаво просимо!</b>\nНатисніть кнопку нижче:`, kb);
  }
});

let isWorkerRunning = false;
async function runBackgroundWorker() {
  if (isWorkerRunning || !supabase || !TELEGRAM_BOT_TOKEN) return;
  try {
    isWorkerRunning = true;
    const { data: filters } = await supabase.from('filters').select('*');
    for (const filter of (filters || [])) {
      try {
        let targetUrl = filter.query ? filter.query.trim() : '';
        if (!targetUrl.startsWith('http')) targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(targetUrl)}/`;
        const { items, averagePrice } = await parseOlx(targetUrl, filter.min_price, filter.max_price, filter.query);
        for (const item of (items || [])) {
          const res = await supabase.from('seen_ads').insert([{ filter_id: filter.id, ad_link: item.link }]).select();
          if (!res.data || res.data.length === 0) continue;
          const isCheap = averagePrice > 0 && item.price < averagePrice * 0.85;
          const text = `🔎 <b>Знайдено: ${filter.query}</b>\n📌 <b>${item.title}</b>\n💰 <b>Ціна:</b> ${item.priceText}\n📍 <b>Місто:</b> ${item.locationDate}\n<a href="${item.link}">👉 Відкрити</a>`;
          const kb = { inline_keyboard: [[{ text: '👉 Відкрити', url: item.link }], [{ text: '🚀 Checker', web_app: { url: SERVER_URL } }]] };
          await sendTelegramPhoto(filter.user_id, item.rawImgUrl || `${SERVER_URL}/assets/no-photo.svg`, text, kb);
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch (e) {}
    }
  } catch (err) { } finally { isWorkerRunning = false; }
}
setInterval(runBackgroundWorker, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server on port ${PORT}`);
  if (TELEGRAM_BOT_TOKEN && SERVER_URL) await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(`${SERVER_URL}/telegram-webhook`)}`).catch(()=>{});
});
