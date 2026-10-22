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
  console.log(`✅ Supabase подключено: ${SUPABASE_URL}`);
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
      return userStr ? JSON.parse(userStr) : null;
    }
  } catch (e) {
    console.error('Ошибка проверки InitData:', e.message);
  }
  return null;
}

async function checkIsAdmin(userId) {
  if (!userId) return false;
  const numericId = parseInt(userId, 10);
  if (ADMIN_IDS.includes(numericId)) return true;
  if (!supabase) return false;

  const { data: user } = await supabase.from('users').select('is_admin').eq('telegram_id', numericId).maybeSingle();
  return Boolean(user && user.is_admin);
}

async function adminAuthMiddleware(req, res, next) {
  const initDataRaw = req.headers['x-telegram-init-data'];
  const user = verifyTelegramWebAppData(initDataRaw);

  if (user && await checkIsAdmin(user.id)) {
    req.adminUser = user;
    return next();
  }

  const reqUserId = req.query.userId || req.body.userId;
  if (reqUserId && await checkIsAdmin(reqUserId)) {
    return next();
  }

  return res.status(403).json({ success: false, error: 'Доступ запрещен: вы не администратор' });
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_markup: replyMarkup
    });
    return true;
  } catch (err) {
    console.error(`Ошибка sendTelegramMessage (${chatId}):`, err.response?.data || err.message);
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
    });
    return true;
  } catch (err) {
    return await sendTelegramMessage(chatId, caption, replyMarkup);
  }
}

// ПРОКСИ ФОТО С ОТДАЧЕЙ ЛОКАЛЬНОГО SVG
app.get('/api/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl || imageUrl.includes('no-photo.svg')) {
      return res.redirect('/assets/no-photo.svg');
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://www.olx.ua/'
      },
      timeout: 5000
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    res.redirect('/assets/no-photo.svg');
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// АВТОРИЗАЦИЯ И ПРОФИЛЬ
app.get('/api/user/profile', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'No userId' });

    const isAdmin = await checkIsAdmin(userId);
    let userData = { tariff: 'free' };

    if (supabase) {
      const { data } = await supabase.from('users').select('*').eq('telegram_id', userId).maybeSingle();
      if (data) userData = data;
      else {
        await supabase.from('users').upsert({ telegram_id: userId, is_admin: isAdmin }, { onConflict: 'telegram_id' });
      }
    }

    if (isAdmin) {
      userData.tariff = 'premium';
      userData.is_admin = true;
    }

    res.json({
      success: true,
      isAdmin,
      user: userData,
      stats: { totalReferrals: 0 }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/filters', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId || !supabase) return res.json({ filters: [] });
    const { data } = await supabase.from('filters').select('*').eq('user_id', userId);
    res.json({ success: true, filters: data || [] });
  } catch (e) {
    res.json({ filters: [] });
  }
});

app.delete('/api/filters/:id', async (req, res) => {
  try {
    if (supabase) {
      await supabase.from('filters').delete().eq('id', req.params.id);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ПАРСЕР OLX
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

  $('[data-cy="l-card"], [data-testid="l-card"]').each((index, element) => {
    if (rawItems.length >= 30) return;

    $(element).find('style, script').remove();
    const title = $(element).find('h6, h4, [data-testid="ad-title"]').first().text().trim();
    if (!title) return;

    const lowerTitle = title.toLowerCase();
    const queryLower = (query || '').toLowerCase();

    const hasStopWord = stopWords.some(word => lowerTitle.includes(word));
    const queryHasStopWord = stopWords.some(word => queryLower.includes(word));

    if (hasStopWord && !queryHasStopWord) return;

    const priceElement = $(element).find('[data-testid="ad-price"]').first();
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

    const rawLink = $(element).find('a').attr('href') || '';
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

    const locationDate = $(element).find('[data-testid="location-date"]').first().text().trim();

    if (title && !isNaN(numericPrice) && numericPrice > 0 && rawLink) {
      rawItems.push({
        id: 'ad_' + Math.random().toString(36).substr(2, 9),
        title,
        price: numericPrice,
        priceText: `${numericPrice.toLocaleString('uk-UA')} грн`,
        link,
        rawImgUrl,
        proxyImg: rawImgUrl ? `${SERVER_URL}/api/proxy-image?url=${encodeURIComponent(rawImgUrl)}` : `${SERVER_URL}/assets/no-photo.svg`,
        locationDate: locationDate || 'Україна',
        description: 'Перегляньте деталі за посиланням на OLX.'
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
    const { query, categoryUrl, minPrice, maxPrice } = req.query;
    let targetUrl = categoryUrl;

    if (!targetUrl && query) {
      if (minPrice || maxPrice) {
        const searchMin = minPrice ? `search%5Bfilter_float_price%3Afrom%5D=${minPrice}` : '';
        const searchMax = maxPrice ? `search%5Bfilter_float_price%3Ato%5D=${maxPrice}` : '';
        const queryParams = [searchMin, searchMax].filter(Boolean).join('&');
        targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(query)}/?${queryParams}`;
      } else {
        targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(query)}/`;
      }
    }

    if (!targetUrl) return res.status(400).json({ error: 'Укажите поисковый запрос' });

    const { items, averagePrice } = await parseOlx(targetUrl, minPrice, maxPrice, query);
    res.json({ success: true, count: items.length, averagePrice, items });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка получения данных с OLX' });
  }
});

// СОЗДАНИЕ ФИЛЬТРА С ТИХИМ ПРОГРЕВОМ
app.post('/api/filters', async (req, res) => {
  try {
    const { userId, query, minPrice, maxPrice, city, condition } = req.body;
    if (!userId || !query) return res.status(400).json({ error: 'Недостаточно данных' });

    if (supabase) {
      await supabase.from('users').upsert({ telegram_id: userId }, { onConflict: 'telegram_id' });

      const { data: userFilters } = await supabase.from('filters').select('id').eq('user_id', userId);
      const { data: userData } = await supabase.from('users').select('*').eq('telegram_id', userId).maybeSingle();

      const isPremium = userData && userData.tariff === 'premium' && new Date(userData.premium_until) > new Date();
      if (!isPremium && userFilters && userFilters.length >= 2) {
        return res.status(403).json({ error: 'LIMIT_EXCEEDED' });
      }

      const { data, error } = await supabase.from('filters').insert([{
        user_id: userId,
        query,
        min_price: parseInt(minPrice) || 0,
        max_price: parseInt(maxPrice) || 0,
        city: city || 'Всі міста',
        condition: condition || 'all'
      }]).select();

      if (error) throw error;
      const createdFilter = data[0];

      try {
        const targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(query)}/`;
        const { items } = await parseOlx(targetUrl, minPrice, maxPrice, query);
        if (items && items.length > 0) {
          const initialSeen = items.map(item => ({
            filter_id: createdFilter.id,
            ad_link: item.link
          }));
          await supabase.from('seen_ads').insert(initialSeen).catch(() => {});
        }
      } catch (warmupErr) {
        console.error('Ошибка прогрева:', warmupErr.message);
      }

      return res.json({ success: true, filter: createdFilter });
    }
    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// АДМИНКА И РАССЫЛКА (ФИКС ОШИБКИ 0 ПОЛЬЗОВАТЕЛЕЙ)
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
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/broadcast', adminAuthMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !supabase) return res.status(400).json({ error: 'Текст рассылки пуст' });

    const { data: users, error } = await supabase.from('users').select('telegram_id');
    if (error || !users || users.length === 0) return res.json({ success: true, sentCount: 0 });

    let sentCount = 0;
    for (const u of users) {
      if (!u.telegram_id) continue;
      const ok = await sendTelegramMessage(u.telegram_id, text);
      if (ok) sentCount++;
      await new Promise(r => setTimeout(r, 50));
    }

    res.json({ success: true, sentCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TELEGRAM BOT WEBHOOK (С АВТО-РЕГИСТРАЦИЕЙ В WEBHOOK)
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update || !update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Записываем пользователя в БД при любом взаимодействии
  if (supabase) {
    await supabase.from('users').upsert({ 
      telegram_id: chatId, 
      first_name: msg.from?.first_name || 'User' 
    }, { onConflict: 'telegram_id' }).catch(() => {});
  }

  if (text.startsWith('/start')) {
    const welcomeText = 
      `👋 <b>Ласкаво просимо до OLX Checker Beta 1.0 RC!</b>\n\n` +
      `⚡️ <b>Твій персональний інструмент для швидкого перекупу та вигідних покупок на OLX.</b>\n\n` +
      `🎯 <b>Що вміє бот:</b>\n` +
      `• <b>Авто-моніторинг 24/7:</b> миттєво знаходить нові оголошення раніше за інших.\n` +
      `• <b>Аналітика ринку:</b> розраховує середню ціну та підказує знижки від 20%.\n` +
      `• <b>Розумні фільтри:</b> відсіює чохли, запчастини, коробки та спам.\n\n` +
      `👑 <b>Переваги PREMIUM:</b>\n` +
      `✓ Перевірка нових товарів кожні <b>60 секунд</b>.\n` +
      `✓ <b>Безлімітні</b> активні відстеження.\n` +
      `✓ Пріоритетне надсилання сповіщень.\n\n` +
      `👇 <i>Натисніть кнопку нижче, щоб відкрити додаток та налаштувати пошук:</i>`;

    const keyboard = {
      inline_keyboard: [[{ text: '🚀 Відкрити OLX Checker', web_app: { url: SERVER_URL } }]]
    };
    await sendTelegramMessage(chatId, welcomeText, keyboard);
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

// ФОНОВЫЙ ВОРКЕР (БЕЗ ФЛУДА)
async function runBackgroundWorker() {
  if (!supabase || !TELEGRAM_BOT_TOKEN) return;

  try {
    const { data: filters } = await supabase.from('filters').select('*');
    if (!filters || filters.length === 0) return;

    for (const filter of filters) {
      try {
        const targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(filter.query)}/`;
        const { items, averagePrice } = await parseOlx(targetUrl, filter.min_price, filter.max_price, filter.query);

        if (!items || items.length === 0) continue;

        for (const item of items) {
          // Записываем в БД
          const { data: inserted, error: insertErr } = await supabase
            .from('seen_ads')
            .insert([{ filter_id: filter.id, ad_link: item.link }])
            .select();

          // Если вставка не удалась (уже было отправлено), переходим к следующему
          if (insertErr || !inserted || inserted.length === 0) continue;

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

          const photoToSend = item.rawImgUrl || `${SERVER_URL}/assets/no-photo.svg`;
          await sendTelegramPhoto(filter.user_id, photoToSend, notificationText, keyboard);
        }
      } catch (fErr) {
        console.error(`Ошибка воркера для фильтра ${filter.id}:`, fErr.message);
      }
    }
  } catch (err) {
    console.error('Ошибка воркера:', err.message);
  }
}

setInterval(runBackgroundWorker, 60000);

// АВТО-РЕГИСТРАЦИЯ WEBHOOK В TELEGRAM
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN || !SERVER_URL) return;
  try {
    const targetWebhookUrl = `${SERVER_URL}/telegram-webhook`;
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(targetWebhookUrl)}`);
    console.log(`✅ Telegram Webhook установлен: ${targetWebhookUrl}`);
  } catch (err) {
    console.error('Ошибка установки Webhook:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await registerWebhook();
});
