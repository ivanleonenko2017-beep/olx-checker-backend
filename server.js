const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(__dirname, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

// Очистка и инициализация Supabase URL
let rawUrl = (process.env.SUPABASE_URL || '').trim();
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);
if (rawUrl.endsWith('/rest/v1')) rawUrl = rawUrl.slice(0, -8);
if (rawUrl.endsWith('/')) rawUrl = rawUrl.slice(0, -1);

const SUPABASE_URL = rawUrl;
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`✅ Supabase подключен к: ${SUPABASE_URL}`);
} else {
  console.warn('⚠️ Переменные SUPABASE_URL или SUPABASE_KEY не заданы!');
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

// Функция продления/выдачи PRO подписки
async function addPremiumDays(userId, days) {
  if (!supabase) return;
  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', userId).maybeSingle();
  
  let now = new Date();
  let baseDate = (user && user.premium_until && new Date(user.premium_until) > now) 
    ? new Date(user.premium_until) 
    : now;

  baseDate.setDate(baseDate.getDate() + days);

  await supabase.from('users').upsert({
    telegram_id: userId,
    tariff: 'premium',
    premium_until: baseDate.toISOString()
  }, { onConflict: 'telegram_id' });
}

// Telegram API функции
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
    console.error(`Ошибка sendMessage (${chatId}):`, err.response?.data || err.message);
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

// Прокси для картинок
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
      timeout: 5000
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    res.status(404).send('Image fetch failed');
  }
});

// Главная страница
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Парсер OLX
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
        locationDate
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

// REST API
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
    res.status(500).json({ success: false, error: 'Помилка отримання данных з OLX' });
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
      return res.json({ success: true, filter: data[0] });
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

// TELEGRAM WEBHOOK (Прием команд и оплаты)
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
        first_name: msg.from.first_name,
        referred_by: (referrerId && referrerId !== chatId) ? referrerId : null
      }]);

      if (referrerId && referrerId !== chatId) {
        await addPremiumDays(referrerId, 3);
        await supabase.from('referral_logs').insert([{ referrer_id: referrerId, referred_id: chatId }]);
        await sendTelegramMessage(referrerId, `🎁 <b>Новий реферал!</b> Пользователь ${msg.from.first_name} зарегистрировался. Вам начислено +3 дня Premium!`);
      }
    }

    await sendTelegramMessage(chatId, `Вітаємо, <b>${msg.from.first_name}</b> в OLX Checker Beta 1.0!\n\nИспользуйте веб-интерфейс для настройки фильтров.`);
    return;
  }

  const { data: user } = await supabase.from('users').select('is_admin').eq('telegram_id', chatId).maybeSingle();
  if (user && user.is_admin) {
    if (text === '/admin') {
      await sendTelegramMessage(chatId, `🛠 <b>Админ Панель:</b>\n/stats - Статистика\n/grant <id> <days> - Выдать PRO\n/broadcast <text> - Рассылка`);
      return;
    }

    if (text === '/stats') {
      const { count: usersCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const { count: filtersCount } = await supabase.from('filters').select('*', { count: 'exact', head: true });
      await sendTelegramMessage(chatId, `📊 <b>Статистика:</b>\nПользователей: ${usersCount}\nАктивных фильтров: ${filtersCount}`);
      return;
    }

    if (text.startsWith('/grant')) {
      const parts = text.split(' ');
      if (parts.length === 3) {
        const targetId = parseInt(parts[1], 10);
        const days = parseInt(parts[2], 10);
        await addPremiumDays(targetId, days);
        await sendTelegramMessage(chatId, `✅ Пользователю ${targetId} выдано ${days} дней Premium.`);
        await sendTelegramMessage(targetId, `🎁 Вам вручную начислено ${days} дней Premium!`);
      }
      return;
    }

    if (text.startsWith('/broadcast')) {
      const broadcastText = text.replace('/broadcast', '').trim();
      if (!broadcastText) return;

      const { data: allUsers } = await supabase.from('users').select('telegram_id');
      let sent = 0;
      for (const u of allUsers) {
        await sendTelegramMessage(u.telegram_id, broadcastText);
        sent++;
        await new Promise(r => setTimeout(r, 50));
      }
      await sendTelegramMessage(chatId, `📢 Рассылка завершена. Доставлено: ${sent}`);
      return;
    }
  }
});

// ФОНОВЫЙ ВОРКЕР (Авто-поиск новых объявлений)
async function runBackgroundWorker() {
  if (!supabase || !TELEGRAM_BOT_TOKEN) return;

  try {
    const { data: filters, error } = await supabase.from('filters').select('*');
    if (error || !filters || filters.length === 0) return;

    console.log(`🔍 Проверка ${filters.length} активных фильтров...`);

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

            const text = `🔥 <b>Знайдено нове оголошення!</b>\n\n` +
                         `<b>${item.title}</b>\n` +
                         `💰 <b>Ціна:</b> ${item.priceText} ${isCheap ? `(Нижче ринку на ${discount}%)` : ''}\n` +
                         `📍 <b>Локація:</b> ${item.locationDate || 'Україна'}\n\n` +
                         `🔎 <i>Запит: ${filter.query}</i>`;

            const keyboard = {
              inline_keyboard: [[{ text: '👉 Відкрити на OLX', url: item.link }]]
            };

            if (item.rawImgUrl) {
              await sendTelegramPhoto(filter.user_id, item.rawImgUrl, text, keyboard);
            } else {
              await sendTelegramMessage(filter.user_id, text, keyboard);
            }
            console.log(`✅ Уведомление отправлено пользователю ${filter.user_id}`);
          }
        }
      } catch (fErr) {
        console.error(`Ошибка обработки фильтра ID ${filter.id}:`, fErr.message);
      }
    }));
  } catch (err) {
    console.error('Ошибка воркера:', err.message);
  }
}

// Запуск воркера каждые 60 секунд
setInterval(runBackgroundWorker, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
