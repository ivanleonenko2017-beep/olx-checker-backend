const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
};

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

    const response = await axios.get(targetUrl, { headers: HEADERS, timeout: 8000 });
    const $ = cheerio.load(response.data);
    const items = [];
    let totalPrices = 0;
    let priceCount = 0;

    $('[data-cy="l-card"]').each((index, element) => {
      if (index >= 15) return;

      const title = $(element).find('h6').text().trim();
      const priceText = $(element).find('[data-testid="ad-price"]').text().trim();
      const link = 'https://www.olx.ua' + $(element).find('a').attr('href');
      const img = $(element).find('img').attr('src') || '';
      const locationDate = $(element).find('[data-testid="location-date"]').text().trim();

      const numericPrice = parseInt(priceText.replace(/\D/g, ''), 10);

      if (title && !isNaN(numericPrice)) {
        totalPrices += numericPrice;
        priceCount++;
        items.push({ title, price: numericPrice, priceText, link, img, locationDate });
      }
    });

    const averagePrice = priceCount > 0 ? Math.round(totalPrices / priceCount) : 0;

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
