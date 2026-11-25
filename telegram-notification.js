'use strict';

const { escapeTelegramHtml } = require('./telegram-html');

function buildListingNotification({
  item = {},
  filter = {},
  hasPriceDrop = false,
  previousPrice = 0,
  isCheap = false,
  discount = 0,
  bargain = {},
  serverUrl = '',
  testMode = false
} = {}) {
  const safeFilterQuery = escapeTelegramHtml(filter.query || '');
  const safeTitle = escapeTelegramHtml(item.title || '');
  const modelVersionLine = item.modelVersion
    ? `📱 <b>Версія:</b> ${escapeTelegramHtml(item.modelVersion)}\n`
    : '';
  const similarModelLine = item.similarModelMatch
    ? '🔎 <b>Схожий варіант за моделлю (за вашим дозволом)</b>\n'
    : '';
  const safeLocation = escapeTelegramHtml(item.locationDate || '');
  const safeItemLink = escapeTelegramHtml(item.link || '');
  const notificationPrice = item.isNegotiable
    ? (item.priceText || 'Договірна') + (item.priceText ? ' · договірна' : '')
    : (item.priceText || 'Ціну не вказано');
  const capacityWarning = item.capacityUnverified
    ? '\n⚠️ <b>' + escapeTelegramHtml(item.capacityVerificationNote || 'Обсяг пам’яті не підтверджено — перевірте характеристики в оголошенні.') + '</b>\n'
    : '';
  const body =
    (hasPriceDrop
      ? `📉 <b>Ціна знизилася для оголошення у фільтрі “${safeFilterQuery}”</b>\n\n<b>Було:</b> ${Number(previousPrice).toLocaleString('uk-UA')} грн → <b>Стало:</b> ${Number(item.price || 0).toLocaleString('uk-UA')} грн\n\n`
      : `🔎 <b>Знайдено нове оголошення для фільтра “${safeFilterQuery}”</b>\n\n`) +
    `📌 <b>${safeTitle}</b>\n` +
    modelVersionLine +
    similarModelLine +
    `💰 <b>Ціна:</b> ${escapeTelegramHtml(notificationPrice)} ${isCheap ? `🔥 (Нижче медіани на ${Number(discount) || 0}%)` : ''}\n` +
    (isCheap && bargain.reliable
      ? `📊 <b>Медіана аналогів:</b> ${Number(bargain.referencePrice).toLocaleString('uk-UA')} грн • ${Number(bargain.comparableCount) || 0} оголошень\n`
      : '') +
    `📍 <b>Місто:</b> ${safeLocation}\n\n` +
    capacityWarning +
    `<a href="${safeItemLink}">👉 Відкрити оголошення на OLX</a>`;
  const text = (testMode ? '🧪 <b>ТЕСТ · Перевірка формату сповіщення</b>\n\n' : '') + body;
  const keyboard = {
    inline_keyboard: [
      [{ text: '👉 Переглянути оголошення', url: item.link }],
      [{ text: '🚀 Відкрити ЗНАЙДЕНО', web_app: { url: serverUrl } }]
    ]
  };
  const photoToSend = item.rawImgUrl
    ? `${serverUrl}/api/proxy-image?url=${encodeURIComponent(item.rawImgUrl)}`
    : `${serverUrl}/assets/no-photo.png`;
  return { text, keyboard, photoToSend };
}

module.exports = { buildListingNotification };
