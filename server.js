const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Віддаємо статичні файли (index.html)
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
    const items = [];
    let totalPrices = 0;

    $('[data-cy="l-card"], [data-testid="l-card"]').each((index, element) => {
      if (items.length >= 20) return;

      // Очищаємо елемент від вкладених стилів і скриптів OLX
      $(element).find('style, script').remove();

      const title = $(element).find('h6, h4, [data-testid="ad-title"]').first().text().trim();
      
      // Фікс CSS-коду: витягуємо суто елемент ціни
      const priceElement = $(element).find('[data-testid="ad-price"]').first();
      priceElement.find('style, script').remove();
      let rawPriceText = priceElement.text().trim();

      // Відсікаємо все, що йде після слів "грн" або CSS-вставок
      if (rawPriceText.includes('грн')) {
        rawPriceText = rawPriceText.split('грн')[0] + ' грн';
      }

      // Парсимо лише перше числове значення ціни
      const match = rawPriceText.match(/(\d[\d\s]*)/);
      let numericPrice = 0;
      if (match) {
        numericPrice = parseInt(match[1].replace(/\s/g, ''), 10);
      }

      const rawLink = $(element).find('a').attr('href') || '';
      const link = rawLink.startsWith('http') ? rawLink : `https://www.olx.ua${rawLink}`;
      
      // Фікс фотографій: зчитуємо lazy-load атрибути data-src або src
      const imgEl = $(element).find('img').first();
      let img = imgEl.attr('src') || imgEl.attr('data-src') || '';
      if (img.startsWith('data:image')) {
        img = imgEl.attr('srcset') ? imgEl.attr('srcset').split(' ')[0] : '';
      }

      const locationDate = $(element).find('[data-testid="location-date"]').first().text().trim();

      if (title && !isNaN(numericPrice) && numericPrice > 0 && rawLink) {
        totalPrices += numericPrice;
        items.push({
          title,
          price: numericPrice,
          priceText: `${numericPrice.toLocaleString('uk-UA')} грн`,
          link,
          img,
          locationDate
        });
      }
    });

    const averagePrice = items.length > 0 ? Math.round(totalPrices / items.length) : 0;

    res.json({
      success: true,
      count: items.length,
      averagePrice,
      items
    });

  } catch (error) {
    console.error('Parsing error:', error.message);
    res.status(500).json({ success: false, error: 'Помилка отримання даних з OLX або блок IP' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
