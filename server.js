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

// Нормализация и парсинг ADMIN_IDS к числовому типу
const ADMIN_IDS = (process.env.ADMIN_IDS || '668277478')
  .split(',')
  .map(id => parseInt(id.trim(), 10))
  .filter(id => !isNaN(id));

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log(`✅ Supabase успішно підключено до: ${SUPABASE_URL}`);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

// Валидация Telegram WebApp initData (HMAC-SHA256)
function verifyTelegramInitData(initDataRaw) {
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
      const userJSON = urlParams.get('user');
      return userJSON ? JSON.parse(userJSON) : null;
    }
  } catch (err) {
    console.error('Помилка перевірки initData:', err.message);
  }
  return null;
}

// Строгая проверка прав администратора (Нормализация типа Number)
async function checkIsAdmin(userId) {
  if (!userId) return false;
  const numericId = parseInt(userId, 10);
  if (isNaN(numericId)) return false;

  if (ADMIN_IDS.includes(numericId)) return true;
  if (!supabase) return false;

  const { data: user } = await supabase.from('users').select('is_admin').eq('telegram_id', numericId).maybeSingle();
  return Boolean(user && user.is_admin === true);
}

// Middleware защиты административных REST API
async function adminAuthMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  let userId = req.query.adminId || req.body.adminId;

  if (initData) {
    const validatedUser = verifyTelegramInitData(initData);
    if (validatedUser) {
      userId = validatedUser.id;
    }
  }

  const isAdmin = await checkIsAdmin(userId);
  if (!isAdmin) {
    return res.status(403).json({ success: false, error: 'У доступі відмовлено: ви не є адміністратором' });
  }

  req.adminUserId = parseInt(userId, 10);
  next();
}

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

// Роут получения профиля пользователя с безопасной проверкой isAdmin
app.get('/api/user/profile', async (req, res) => {
  try {
    const initData = req.headers['x-telegram-init-data'];
    let userId = req.query.userId;

    if (initData) {
      const validated = verifyTelegramInitData(initData);
      if (validated) userId = validated.id;
    }

    if (!supabase || !userId) return res.status(400).json({ error: 'Не вказано ідентифікатор користувача' });

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

// АДМИНИСТРАТИВНЫЕ ЭНДПОИНТЫ REST API
app.get('/api/admin/stats', adminAuthMiddleware, async (req, res) => {
  try {
    const { count: usersCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: filtersCount } = await supabase.from('filters').select('*', { count: 'exact', head: true });
    const { count: premiumCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('tariff', 'premium');
    const { count: refCount } = await supabase.from('referral_logs').select('*', { count: 'exact', head: true });

    res.json({
      success: true,
      stats: {
        users: usersCount || 0,
        filters: filtersCount || 0,
        premium: premiumCount || 0,
        referrals: refCount || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/grant-premium', adminAuthMiddleware, async (req, res) => {
  try {
    const { targetUserId, days } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Вкажіть ID користувача' });

    await addPremiumDays(targetUserId, parseInt(days) || 30);
    await sendTelegramMessage(targetUserId, `🎁 <b>Адміністратор нарахував вам ${days} днів Premium!</b>`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/revoke-premium', adminAuthMiddleware, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Вкажіть ID користувача' });

    await supabase.from('users').update({ tariff: 'free', premium_until: null }).eq('telegram_id', targetUserId);
    await sendTelegramMessage(targetUserId, `ℹ️ <b>Вашу Premium-підписку було відкликано адміністратором.</b>`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TELEGRAM WEBHOOK (Гарантированная обработка /start и /admin)
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  const webAppUrl = process.env.SERVER_URL || 'https://olx-checker-backend.onrender.com';

  // Обработка /start
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
        await sendTelegramMessage(referrerId, `🎁 <b>Новий реферал!</b> Користувач ${msg.from.first_name || ''} зареєструвався. Вам нараховано +3 дні Premium!`);
      }
    }

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
      `Натисніть кнопку нижче, щоб відкрити додаток:`;

    await sendTelegramMessage(chatId, welcomeMessage, keyboard);
    return;
  }

  // Обработка /admin без "молчания"
  if (text.startsWith('/admin')) {
    const isAdmin = await checkIsAdmin(chatId);

    if (!isAdmin) {
      await sendTelegramMessage(chatId, `❌ <b>У доступі відмовлено.</b> Ваш ID: <code>${chatId}</code> не знайдено у списку адміністраторів.`);
      return;
    }

    const adminKeyboard = {
      inline_keyboard: [
        [{ text: '⚙️ Відкрити Адмін-панель', web_app: { url: `${webAppUrl}?screen=admin` } }]
      ]
    };

    await sendTelegramMessage(chatId, `🛠 <b>Панель Адміністрування OLX Checker</b>\n\nВи маєте підтверджені права адміністратора. Натисніть кнопку нижче для переходу до панелі управління:`, adminKeyboard);
    return;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
