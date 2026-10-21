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
      priceElement.find('style, script
