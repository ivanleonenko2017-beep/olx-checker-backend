const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Отключение кэширования для статики и API
app.use(express.static(__dirname, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

// Очистка и нормализация Supabase URL
let rawUrl = (process.env.SUPABASE_URL || '').trim();
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);
if (rawUrl.endsWith('/rest/v1')) rawUrl = rawUrl.slice(0, -8);
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);

const SUPABASE_URL = rawUrl;
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

// Список ID администраторов из переменных окружения
const ADMIN_IDS = (process.env.ADMIN_IDS || '668277478')
  .split(',')
  .map(id => parseInt(id.trim(), 10))
  .filter(Boolean);

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`✅ Supabase успішно підключено до: ${SUPABASE_URL}`);
} else {
  console.warn('⚠️ Змінні SUPABASE_URL або SUPABASE_KEY не задані!');
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

// Хелпер проверки прав администратора
async function checkIsAdmin(userId) {
  if (!userId) return false;
  const numericId = parseInt(userId, 10);
  if (ADMIN_IDS.includes(numericId)) return true;
  if (!supabase) return false;

  const { data: user } = await supabase.from('users').select('is_admin').eq('telegram_id', numericId).maybeSingle();
  return Boolean(user && user.is_admin);
}

// Начисление Premium подписки
async function addPremiumDays(userId, days) {
  if (!supabase) return;
  const numericId = parseInt(userId, 10);
  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', numericId).maybeSingle();
  
  const now = new Date();
  let baseDate = (user && user.premium_until && new Date(user.premium_until) > now) 
    ? new Date(user.premium_until) 
    : now;

  baseDate.setDate(baseDate.getDate() + days);

  await supabase.from('users').upsert({
    telegram_id: numericId,
    tariff: 'premium',
    premium_until: baseDate.toISOString()
  }, { onConflict: 'telegram_id' });
}

// Telegram API wrappers
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_markup: replyMarkup
    });
  } catch (err) {
    console.error(`Помилка sendTelegramMessage (${chatId}):`, err.response?.data || err.message);
  }
}

async function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
  } catch (err) {
    await sendTelegramMessage(chatId, caption, replyMarkup);
  }
}

// Проксирование изображений
app.get('/api/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('No image URL provided');

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://www.olx.ua/'
      },
      timeout: 7000
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    res.status(404).send('Image fetch failed');
  }
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Канонический парсер OLX
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
        proxyImg: rawImgUrl ? `/api/proxy-image?url=${encodeURIComponent(rawImgUrl)}` : '',
        locationDate: locationDate || 'Україна',
        description: 'Опис відсутній'
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

// REST API Поиска
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

    if (!targetUrl) return res.status(400).json({ error: 'Вкажіть пошуковий запит' });

    const { items, averagePrice } = await parseOlx(targetUrl, minPrice, maxPrice, query);
    res.json({ success: true, count: items.length, averagePrice, items });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Помилка отримання даних з OLX' });
  }
});

// Профиль пользователя и проверка статуса Админа
app.get('/api/user/profile', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!supabase || !userId) return res.status(400).json({ error: 'Не вказано userId' });

    const numericId = parseInt(userId, 10);
    const { data: user } = await supabase.from('users').select('*').eq('telegram_id', numericId).maybeSingle();
    const { count: filterCount } = await supabase.from('filters').select('*', { count: 'exact', head: true }).eq('user_id', numericId);
    const { count: refCount } = await supabase.from('referral_logs').select('*', { count: 'exact', head: true }).eq('referrer_id', numericId);
    const isAdmin = await checkIsAdmin(numericId);

    res.json({
      success: true,
      user: user || { telegram_id: numericId, tariff: 'free' },
      isAdmin,
      stats: {
        activeFilters: filterCount || 0,
        totalReferrals: refCount || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/filters', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!supabase || !userId) return res.json({ filters: [] });
    const { data } = await supabase.from('filters').select('*').eq('user_id', userId);
    res.json({ filters: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/filters', async (req, res) => {
  try {
    const { userId, query, minPrice, maxPrice, city, condition } = req.body;
    if (!userId || !query) return res.status(400).json({ error: 'Недостатньо даних' });

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

      // Прогрев без отправки спама
      try {
        const targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(query)}/`;
        const { items } = await parseOlx(targetUrl, minPrice, maxPrice, query);
        if (items && items.length > 0) {
          const seenRecords = items.map(item => ({
            filter_id: createdFilter.id,
            ad_link: item.link
          }));
          await supabase.from('seen_ads').insert(seenRecords).catch(() => {});
        }
      } catch (e) {
        console.error('Помилка первинного прогріву:', e.message);
      }

      return res.json({ success: true, filter: createdFilter });
    }
    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/filters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (supabase) await supabase.from('filters').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// АДМИНИСТРАТИВНЫЕ REST API СЕРВЕРА
app.get('/api/admin/stats', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (!(await checkIsAdmin(adminId))) {
      return res.status(403).json({ error: 'Доступ заборонено' });
    }

    const { count: usersCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: filtersCount } = await supabase.from('filters').select('*', { count: 'exact', head: true });
    const { count: premiumCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('tariff', 'premium');

    res.json({
      success: true,
      stats: {
        users: usersCount || 0,
        filters: filtersCount || 0,
        premium: premiumCount || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (!(await checkIsAdmin(adminId))) {
      return res.status(403).json({ error: 'Доступ заборонено' });
    }

    const { data: users } = await supabase.from('users').select('*').order('created_at', { ascending: false }).limit(50);
    res.json({ success: true, users: users || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/grant-premium', async (req, res) => {
  try {
    const { adminId, targetUserId, days } = req.body;
    if (!(await checkIsAdmin(adminId))) {
      return res.status(403).json({ error: 'Доступ заборонено' });
    }

    await addPremiumDays(targetUserId, parseInt(days) || 30);
    await sendTelegramMessage(targetUserId, `🎁 <b>Адміністратор нарахував вам ${days} днів Premium!</b>`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TELEGRAM BOT WEBHOOK
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  if (update.pre_checkout_query) {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
      pre_checkout_query_id: update.pre_checkout_query.id,
      ok: true
    });
    return;
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Оплата Telegram Stars
  if (msg.successful_payment) {
    const payload = JSON.parse(msg.successful_payment.invoice_payload);
    await addPremiumDays(chatId, payload.days);
    await supabase.from('payments').insert([{
      user_id: chatId,
      provider: 'telegram_stars',
      amount: msg.successful_payment.total_amount,
      days_added: payload.days,
      payload: msg.successful_payment.telegram_payment_charge_id
    }]);
    await sendTelegramMessage(chatId, `🎉 <b>Оплата успішна!</b>\nВам надано Premium на ${payload.days} днів.`);
    return;
  }

  // Команда /start на украинском языке с Onboarding
  if (text.startsWith('/start')) {
    const args = text.split(' ');
    let referrerId = null;

    if (args.length > 1 && args[1].startsWith('ref_')) {
      referrerId = parseInt(args[1].replace('ref_', ''), 10);
    }

    const { data: existingUser } = await supabase.from('users').select('*').eq('telegram_id', chatId).maybeSingle();

    if (!existingUser) {
      await supabase.from('users').insert([{
        telegram_id: chatId,
        first_name: msg.from.first_name || 'Користувач',
        referred_by: (referrerId && referrerId !== chatId) ? referrerId : null
      }]);

      if (referrerId && referrerId !== chatId) {
        await addPremiumDays(referrerId, 3);
        await supabase.from('referral_logs').insert([{ referrer_id: referrerId, referred_id: chatId }]).catch(() => {});
        await sendTelegramMessage(referrerId, `🎁 <b>Новий реферал!</b> Користувач ${msg.from.first_name} зареєструвався. Вам нараховано +3 дні Premium!`);
      }
    }

    const webAppUrl = process.env.SERVER_URL || 'https://olx-checker-backend.onrender.com';
    const keyboard = {
      inline_keyboard: [
        [{ text: '🚀 Відкрити OLX Checker', web_app: { url: webAppUrl } }]
      ]
    };

    const welcomeMessage = `Вітаємо в <b>OLX Checker Beta 1.0</b>! 🚀\n\n` +
      `Створюйте фільтри для пошуку оголошень на OLX та отримуйте миттєві сповіщення про нові пропозиції.\n\n` +
      `📌 <b>Можливості:</b>\n` +
      `• Моніторинг нових оголошень 24/7\n` +
      `• Автоматичний розрахунок середньої ціни та знижок\n` +
      `• Реферальна програма (+3 дні PRO за друга)\n\n` +
      `Створіть перший фільтр, щоб почати відстеження:`;

    await sendTelegramMessage(chatId, welcomeMessage, keyboard);
    return;
  }

  // Команды Администратора
  const isAdmin = await checkIsAdmin(chatId);

  if (text.startsWith('/admin') || text.startsWith('/stats') || text.startsWith('/grant') || text.startsWith('/broadcast')) {
    if (!isAdmin) {
      await sendTelegramMessage(chatId, '❌ <b>У доступі відмовлено.</b> Ця команда доступна лише адміністраторам.');
      return;
    }

    if (text === '/admin') {
      await sendTelegramMessage(chatId, `🛠 <b>Адмін Панель OLX Checker:</b>\n\n/stats — Статистика системи\n/grant <id> <days> — Видати Premium\n/broadcast <text> — Масова розсилка`);
      return;
    }

    if (text === '/stats') {
      const { count: usersCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const { count: filtersCount } = await supabase.from('filters').select('*', { count: 'exact', head: true });
      await sendTelegramMessage(chatId, `📊 <b>Статистика бота:</b>\n\nКористувачів: <b>${usersCount || 0}</b>\nАктивних фільтрів: <b>${filtersCount || 0}</b>`);
      return;
    }

    if (text.startsWith('/grant')) {
      const parts = text.split(' ');
      if (parts.length === 3) {
        const targetId = parseInt(parts[1], 10);
        const days = parseInt(parts[2], 10);
        await addPremiumDays(targetId, days);
        await sendTelegramMessage(chatId, `✅ Користувачу <code>${targetId}</code> видано ${days} днів Premium.`);
        await sendTelegramMessage(targetId, `🎁 Вам вручну нараховано ${days} днів Premium!`);
      }
      return;
    }

    if (text.startsWith('/broadcast')) {
      const broadcastText = text.replace('/broadcast', '').trim();
      if (!broadcastText) return;

      const { data: allUsers } = await supabase.from('users').select('telegram_id');
      let sent = 0;
      for (const u of (allUsers || [])) {
        await sendTelegramMessage(u.telegram_id, broadcastText);
        sent++;
        await new Promise(r => setTimeout(r, 50));
      }
      await sendTelegramMessage(chatId, `📢 Розсилку завершено. Доставлено: ${sent}`);
      return;
    }
  }
});

// ФОНОВЫЙ ВОРКЕР МАРКЕТПЛЕЙСА
async function runBackgroundWorker() {
  if (!supabase || !TELEGRAM_BOT_TOKEN) return;

  try {
    const { data: filters, error } = await supabase.from('filters').select('*');
    if (error || !filters || filters.length === 0) return;

    console.log(`🔍 Перевірка ${filters.length} активних фільтрів...`);

    await Promise.allSettled(filters.map(async (filter) => {
      try {
        const targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(filter.query)}/`;
        const { items, averagePrice } = await parseOlx(targetUrl, filter.min_price, filter.max_price, filter.query);

        if (!items || items.length === 0) return;

        for (const item of items) {
          const { data: seen } = await supabase.from('seen_ads')
            .select('id')
            .eq('filter_id', filter.id)
            .eq('ad_link', item.link);

          if (!seen || seen.length === 0) {
            await supabase.from('seen_ads').insert([{ filter_id: filter.id, ad_link: item.link }]);

            const isCheap = averagePrice > 0 && item.price < averagePrice * 0.85;
            const discount = isCheap ? Math.round((1 - item.price / averagePrice) * 100) : 0;

            const text = `🔥 <b>НОВЕ ОГОЛОШЕННЯ</b>\n\n` +
                         `📌 <b>Назва:</b> ${item.title}\n` +
                         `💰 <b>Ціна:</b> ${item.priceText} ${isCheap ? `(Нижче ринку на ${discount}%)` : ''}\n` +
                         `📍 <b>Місцеположення:</b> ${item.locationDate || 'Україна'}\n` +
                         `📝 <b>Опис:</b> ${item.description}\n\n` +
                         `🔎 <i>Запит: ${filter.query}</i>`;

            const keyboard = {
              inline_keyboard: [[{ text: '👉 Відкрити на OLX', url: item.link }]]
            };

            if (item.rawImgUrl) {
              await sendTelegramPhoto(filter.user_id, item.rawImgUrl, text, keyboard);
            } else {
              await sendTelegramMessage(filter.user_id, text, keyboard);
            }
            console.log(`✅ Сповіщення відправлено користувачу ${filter.user_id}`);
          }
        }
      } catch (fErr) {
        console.error(`Помилка фільтра ID ${filter.id}:`, fErr.message);
      }
    }));
  } catch (err) {
    console.error('Помилка воркера:', err.message);
  }
}

setInterval(runBackgroundWorker, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
