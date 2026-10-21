const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(__dirname));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/search', async (req, res) => {
  try {
    const { query, categoryUrl } = req.query;
    let targetUrl = categoryUrl;

    if (!targetUrl && query) {
      targetUrl = `https://www.olx.ua/uk/list/q-${encodeURIComponent(query)}/`;
    }

    if (!targetUrl) {
      return res.status(400).json({ error: 'Вкажіть пошуковий запит або посилання OLX' });
    }

    const response = await axios.get(targetUrl, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(response.data);
    const rawItems = [];

    // Расширенный список слов-исключений (детали, запчасти, блокировки, аксессуары)
    const stopWords = [
      'аккумулятор', 'акумулятор', 'батарея', 'батарейка', 'корпус', 'корпуси', 'корпуса',
      'шлейф', 'плата', 'материнская плата', 'материнська плата', 'камера', 'динамик', 'динамік',
      'стекло', 'скло', 'чехол', 'чохол', 'чохли', 'чехлы', 'дисплей', 'экран', 'екран', 'тачскрин',
      'коробка', 'кабель', 'зарядка', 'зарядное', 'зарядний', 'адаптер', 'ремешок', 'ремінець', 
      'пленка', 'плівка', 'запчасти', 'запчастини', 'разборка', 'розбірка', 'на запчастини', 
      'на запчасти', 'icloud', 'айклауд', 'lost', 'passcode', 'пароль', 'байпас', 'bypass', 
      'донор', 'скупка', 'ремонт'
    ];

    $('[data-cy="l-card"], [data-testid="l-card"]').each((index, element) => {
      if (rawItems.length >= 30) return;

      $(element).find('style, script').remove();

      const title = $(element).find('h6, h4, [data-testid="ad-title"]').first().text().trim();
      if (!title) return;

      const lowerTitle = title.toLowerCase();
      const queryLower = (query || '').toLowerCase();

      // Фильтрация мусора: отсекаем объявленя, если в названии есть стоп-слова
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

      const rawLink = $(element).find('a').attr('href') || '';
      const link = rawLink.startsWith('http') ? rawLink : `https://www.olx.ua${rawLink}`;
      
      // Посегментный поиск картинки напрямую из HTML карточки
      let img = '';
      const cardHtml = $(element).html();
      const imgMatches = cardHtml.match(/https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/gi);
      
      if (imgMatches && imgMatches.length > 0) {
        const validImg = imgMatches.find(url => !url.includes('data:image') && !url.includes('blank') && !url.includes('static'));
        if (validImg) img = validImg;
      }

      if (!img) {
        const imgEl = $(element).find('img').first();
        img = imgEl.attr('src') || imgEl.attr('data-src') || '';
        if (img.startsWith('//')) img = 'https:' + img;
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

    // Расчет средней рыночной цены на основе чистых объявлений
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
