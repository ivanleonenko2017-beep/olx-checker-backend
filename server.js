const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Вимикаємо кешування для статики
app.use(express.static(__dirname, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

// Головна сторінка без кешування
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'index.html'));
});

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
