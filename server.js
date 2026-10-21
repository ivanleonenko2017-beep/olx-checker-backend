const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

// Вбудований інтерфейс Mini App (HTML + CSS + JS)
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>OLX Checker Mini App</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      background-color: var(--tg-theme-bg-color, #121212);
      color: var(--tg-theme-text-color, #ffffff);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
  </style>
</head>
<body class="p-4">
  <div id="app" class="max-w-md mx-auto space-y-4">
    
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-gray-800 pb-3">
      <div>
        <h1 class="text-xl font-bold text-emerald-400">OLX Checker <span class="text-xs bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-800">BETA v3</span></h1>
        <div id="userInfo" class="text-xs text-gray-400 mt-0.5">Користувач: Гість</div>
      </div>
      <span class="text-xs bg-gray-800 text-gray-300 px-2.5 py-1 rounded-full">Free Тариф</span>
    </div>

    <!-- Search Form -->
    <div class="space-y-3 bg-gray-900/60 p-3.5 rounded-2xl border border-gray-800">
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1">Пошуковий запит або посилання OLX</label>
        <input type="text" id="searchInput" placeholder="Введіть 'iPhone 11' або вставте посилання OLX" 
               class="w-full p-3 rounded-xl bg-gray-900 border border-gray-700 text-sm text-white focus:outline-none focus:border-emerald-500 transition">
      </div>

      <!-- Quick Price Filters -->
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Мін. ціна (грн)</label>
          <input type="number" id="minPrice" placeholder="0" 
                 class="w-full p-2.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-white focus:outline-none focus:border-emerald-500">
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Макс. ціна (грн)</label>
          <input type="number" id="maxPrice" placeholder="Без ліміту" 
                 class="w-full p-2.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-white focus:outline-none focus:border-emerald-500">
        </div>
      </div>

      <button onclick="runSearch()" id="searchBtn" 
              class="w-full bg-emerald-500 hover:bg-emerald-600 text-black font-semibold py-3 rounded-xl transition flex items-center justify-center text-sm shadow-lg shadow-emerald-950">
        🔍 Знайти оголошення
      </button>
    </div>

    <!-- Analytics Dashboard -->
    <div id="analytics" class="hidden p-4 rounded-2xl bg-gray-900 border border-gray-800 space-y-2">
      <div class="text-xs text-gray-400">Аналітика ринку</div>
      <div class="flex justify-between items-end">
        <div>
          <div class="text-2xl font-bold text-white" id="avgPrice">0 грн</div>
          <div class="text-xs text-gray-400">Середня ціна на ринку</div>
        </div>
        <span id="itemsCount" class="text-xs bg-blue-900/50 text-blue-300 px-2.5 py-1 rounded-full border border-blue-800">Аналіз 0 товарів</span>
      </div>
    </div>

    <!-- Referral & Subscription Banner -->
    <div class="p-3.5 rounded-2xl bg-gradient-to-r from-emerald-950/60 to-gray-900 border border-emerald-900/50 flex justify-between items-center">
      <div>
        <div class="text-xs font-bold text-emerald-300">Отримай PRO за друзів 🎁</div>
        <div class="text-[11px] text-gray-400">Запрошуй друзів та отримуй швидкі сповіщення без затримок</div>
      </div>
      <button onclick="shareReferralLink()" 
              class="text-xs bg-emerald-500 text-black font-semibold px-3 py-1.5 rounded-lg border border-emerald-400 hover:bg-emerald-400 transition">
        Запросити
      </button>
    </div>

    <!-- Results Feed -->
    <div id="results" class="space-y-3"></div>
  </div>

  <script>
    const tg = window.Telegram.WebApp;
    let userId = null;

    if (tg) {
      tg.ready();
      tg.expand();
      if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
        userId = tg.initDataUnsafe.user.id;
        const name = tg.initDataUnsafe.user.first_name || 'Користувач';
        document.getElementById('userInfo').innerText = 'Користувач: ' + name;
      }
    }

    const BACKEND_URL = window.location.origin;

    function shareReferralLink() {
      if (!userId) {
        alert('Відкрийте додаток всередині Telegram, щоб отримати реферальну ссылку.');
        return;
      }
      const refLink = 'https://t.me/OLXhelpler_bot?start=ref_' + userId;
      const shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(refLink) + '&text=' + encodeURIComponent('Користуйся швидким OLX Чекером для пошуку вигідних оголошень!');
      if (tg && tg.openTelegramLink) {
        tg.openTelegramLink(shareUrl);
      } else {
        window.open(shareUrl, '_blank');
      }
    }

    async function runSearch() {
      const inputVal = document.getElementById('searchInput').value.trim();
      const minPrice = document.getElementById('minPrice').value.trim();
      const maxPrice = document.getElementById('maxPrice').value.trim();

      if (!inputVal) return;

      const btn = document.getElementById('searchBtn');
      const resultsDiv = document.getElementById('results');
      const analyticsDiv = document.getElementById('analytics');

      btn.disabled = true;
      btn.innerText = 'Шукаємо...';
      resultsDiv.innerHTML = '<div class="text-center text-gray-400 py-8">Завантаження даних з OLX...</div>';

      try {
        let apiUrl = BACKEND_URL + '/api/search?';
        
        if (inputVal.startsWith('http://') || inputVal.startsWith('https://')) {
          apiUrl += 'categoryUrl=' + encodeURIComponent(inputVal);
        } else {
          apiUrl += 'query=' + encodeURIComponent(inputVal);
        }

        if (minPrice) apiUrl += '&minPrice=' + minPrice;
        if (maxPrice) apiUrl += '&maxPrice=' + maxPrice;

        const res = await fetch(apiUrl);
        const data = await res.json();

        if (!data.success || !data.items || data.items.length === 0) {
          resultsDiv.innerHTML = '<div class="text-center text-red-400 py-6 bg-gray-900 rounded-2xl border border-gray-800">Оголошень за даним запитом не знайдено.</div>';
          analyticsDiv.classList.add('hidden');
          return;
        }

        document.getElementById('avgPrice').innerText = data.averagePrice.toLocaleString('uk-UA') + ' грн';
        document.getElementById('itemsCount').innerText = 'Знайдено ' + data.count + ' товарів';
        analyticsDiv.classList.remove('hidden');

        resultsDiv.innerHTML = data.items.map(item => {
          const isCheap = item.price > 0 && data.averagePrice > 0 && item.price < data.averagePrice * 0.85;
          const discount = isCheap ? Math.round((1 - item.price / data.averagePrice) * 100) : 0;

          return \`
            <a href="\${item.link}" target="_blank" class="block p-3 rounded-2xl bg-gray-900 border \${isCheap ? 'border-emerald-500/80 bg-emerald-950/10' : 'border-gray-800'} space-y-2 hover:border-gray-700 transition">
              <div class="flex gap-3">
                \${item.img ? \`<img src="\${item.img}" class="w-20 h-20 object-cover rounded-xl bg-gray-800 flex-shrink-0">\` : '<div class="w-20 h-20 bg-gray-800 rounded-xl flex items-center justify-center text-[10px] text-gray-500">Без фото</div>'}
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-semibold text-white truncate">\${item.title}</div>
                  <div class="text-base font-bold \${isCheap ? 'text-emerald-400' : 'text-white'} mt-1">\${item.priceText}</div>
                  <div class="text-[11px] text-gray-400 mt-1 truncate">\${item.locationDate || ''}</div>
                </div>
              </div>
              \${isCheap ? \`<div class="text-xs bg-emerald-950/80 text-emerald-300 px-2.5 py-1 rounded-xl border border-emerald-800/60 text-center font-medium">🔥 Вигідно! Нижче ринку на \${discount}%</div>\` : ''}
            </a>
          \`;
        }).join('');

      } catch (err) {
        console.error(err);
        resultsDiv.innerHTML = '<div class="text-center text-red-400 py-4">Помилка з\\'єднання з сервером.</div>';
      } finally {
        btn.disabled = false;
        btn.innerText = '🔍 Знайти оголошення';
      }
    }
  </script>
</body>
</html>
`;

// Головний маршрут — віддає HTML без кешування
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(HTML_CONTENT);
});

// API для пошуку та парсингу OLX
app.get('/api/search', async (req, res) => {
  try {
    const { query, categoryUrl, minPrice, maxPrice } = req.query;
    let targetUrl = categoryUrl;

    if (!targetUrl && query) {
      let searchParams = `q-${encodeURIComponent(query)}/`;
      if (minPrice || maxPrice) {
        const searchMin = minPrice ? `search%5Bfilter_float_price%3Afrom%5D=${minPrice}` : '';
        const searchMax = maxPrice ? `search%5Bfilter_float_price%3Ato%5D=${maxPrice}` : '';
        const queryParams = [searchMin, searchMax].filter(Boolean).join('&');
        targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(query)}/?${queryParams}`;
      } else {
        targetUrl = `https://www.olx.ua/uk/list/${searchParams}`;
      }
    }

    if (!targetUrl) {
      return res.status(400).json({ error: 'Вкажіть пошуковий запит або посилання OLX' });
    }

    const response = await axios.get(targetUrl, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(response.data);
    const rawItems = [];

    const stopWords = [
      'аккумулятор', 'акумулятор', 'батарея', 'батарейка', 'корпус', 'корпуси', 'корпуса',
      'шлейф', 'плата', 'материнская плата', 'материнська плата', 'камера', 'динамик', 'динамік',
      'стекло', 'скло', 'чехол', 'чохол', 'чохли', 'чехлы', 'накладка', 'наклейка', 'бампер',
      'дисплей', 'экран', 'екран', 'тачскрин', 'коробка', 'кабель', 'зарядка', 'зарядное', 
      'зарядний', 'адаптер', 'ремешок', 'ремінець', 'пленка', 'плівка', 'гидрогель', 'гідрогель',
      'запчасти', 'запчастини', 'разборка', 'розбірка', 'на запчастини', 'на запчасти', 
      'icloud', 'айклауд', 'lost', 'passcode', 'пароль', 'байпас', 'bypass', 'донор', 
      'скупка', 'ремонт', 'копия', 'копія', 'реплика', 'репліка', 'держатель', 'тримач'
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
      
      let img = '';
      const imgEl = $(element).find('img').first();
      const src = imgEl.attr('src') || '';
      const dataSrc = imgEl.attr('data-src') || '';
      const srcset = imgEl.attr('srcset') || imgEl.attr('data-srcset') || '';

      let candidate = '';
      if (dataSrc && !dataSrc.startsWith('data:')) {
        candidate = dataSrc;
      } else if (srcset && !srcset.startsWith('data:')) {
        candidate = srcset.split(',')[0].trim().split(' ')[0];
      } else if (src && !src.startsWith('data:')) {
        candidate = src;
      }

      if (!candidate) {
        const sourceSrcset = $(element).find('picture source').first().attr('srcset') \vert{}\vert{}$(element).find('picture source').first().attr('data-srcset') || '';
        if (sourceSrcset && !sourceSrcset.startsWith('data:')) {
          candidate = sourceSrcset.split(',')[0].trim().split(' ')[0];
        }
      }

      if (!candidate) {
        const cardHtml = $(element).html() || '';
        const cdnMatch = cardHtml.match(/https?:\/\/[^"'\s<>]*?olxcdn[^"'\s<>]*/gi);
        if (cdnMatch && cdnMatch.length > 0) {
          candidate = cdnMatch[0];
        }
      }

      if (candidate) {
        candidate = candidate.replace(/\\/g, '').replace(/&amp;/g, '&');
        if (candidate.startsWith('//')) {
          candidate = 'https:' + candidate;
        } else if (candidate.startsWith('/')) {
          candidate = 'https://www.olx.ua' + candidate;
        }
        if (!candidate.startsWith('data:')) {
          img = candidate;
        }
      }

      const locationDate = $(element).find('[data-testid="location-date"]').first().text().trim();

      if (title && !isNaN(numericPrice) && numericPrice > 0 && rawLink) {
        rawItems.push({
          title,
          price: numericPrice,
          priceText: `${numericPrice.toLocaleString('uk-UA')} грн`,
          link,
          img,
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

    res.json({
      success: true,
      count: rawItems.length,
      averagePrice,
      items: rawItems
    });

  } catch (error) {
    console.error('Parsing error:', error.message);
    res.status(500).json({ success: false, error: 'Помилка отримання даних з OLX або блок IP' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
