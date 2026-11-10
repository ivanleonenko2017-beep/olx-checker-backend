'use strict';

const { escapeTelegramHtml } = require('./telegram-html');

function safe(value, max = 180) {
  return String(value ?? '')
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, '[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function consumeRateLimit(map, key, now = Date.now(), intervalMs = 60000) {
  const previous = map.get(key) || 0;
  if (now - previous < intervalMs) return false;
  map.set(key, now);
  if (map.size > 1000) {
    for (const [entry, timestamp] of map) {
      if (now - timestamp > intervalMs * 10) map.delete(entry);
    }
  }
  return true;
}

async function isAdminCommandAuthorized(userId, checkAdmin) {
  if (!userId || typeof checkAdmin !== 'function') return false;
  try { return Boolean(await checkAdmin(userId)); } catch { return false; }
}

function splitTelegramMessages(parts, maxLength = 3600) {
  const messages = [];
  let current = '';
  const units = [];
  for (const part of parts.filter(Boolean)) {
    for (const line of String(part).split('\n')) {
      if (line.length <= maxLength) units.push(line);
      else {
        for (let offset = 0; offset < line.length; offset += maxLength) {
          units.push(line.slice(offset, offset + maxLength));
        }
      }
    }
  }
  for (const unit of units) {
    const candidate = current ? current + '\n' + unit : unit;
    if (candidate.length > maxLength && current) {
      messages.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function formatDiagnosticMessages(data = {}) {
  const f = data.funnel || {};
  const at = data.at || new Date().toISOString();
  const header = [
    '<b>ЗНАЙДЕНО · Діагностика пошуку</b>',
    '<b>requestId:</b> ' + escapeTelegramHtml(safe(data.requestId, 24)),
    '<b>Час UTC:</b> ' + escapeTelegramHtml(at),
    '<b>Час Київ:</b> ' + escapeTelegramHtml(data.kyivTime || 'не визначено'),
    '<b>Пагінація:</b> ' + escapeTelegramHtml(safe(data.stopReason || 'unknown', 50))
  ].join('\n');

  const pages = ['<b>Сторінки</b>'];
  for (const p of (data.pages || [])) {
    pages.push(
      '#' + Number(p.page || 0) +
      ' · HTTP ' + escapeTelegramHtml(String(p.httpStatus ?? '—')) +
      ' · ' + Number(p.durationMs || 0) + ' мс' +
      ' · ' + (p.responseBytes == null ? 'розмір невідомий' : Number(p.responseBytes) + ' байт') +
      ' · карток DOM ' + Number(p.cardsOnPage || 0) +
      ' · розпарсено ' + Number(p.cardsParsed || 0) +
      ' · нових ' + Number(p.newAfterDedup || 0)
    );
  }
  if (!data.pages?.length) pages.push('Сторінки не отримані');

  const funnel = [
    '<b>Воронка</b>',
    'Розпарсено: ' + Number(f.parsed || 0) + ' → після dedup: ' + Number(f.afterDedup || 0),
    'Місто: ' + Number(f.afterCity || 0) + ' → модель: ' + Number(f.after_model ?? f.afterModel ?? 0),
    'Пам’ять: ' + Number(f.afterMemoryIncludingUnverified ?? f.after_memory ?? 0) +
      ' (не підтверджена: ' + Number(f.capacityUnverified || 0) + ')',
    'Виключення: ' + Number(f.after_excluded_words ?? 0),
    'Ціна: ' + Number(f.after_price ?? 0) + ' → стан: ' + Number(f.after_condition ?? 0),
    'Порядок конвеєра: ціна перед станом; класифікація рекомендацій OLX не інструментована.',
    'Підсумок: ' + Number(f.final || 0) +
      ' · місто не підтверджено: ' + Number(f.cityUnverified || 0)
  ].join('\n');

  const cards = ['<b>Картки (максимум 40)</b>'];
  for (const c of (data.cards || []).slice(0, 40)) {
    cards.push(
      Number(c.position || 0) + '. ' + escapeTelegramHtml(safe(c.title, 100)) +
      ' · ' + escapeTelegramHtml(safe(c.price || 'ціна не вказана', 32)) +
      ' · ' + escapeTelegramHtml(safe(c.city || 'місто не визначено', 60)) +
      ' · ' + escapeTelegramHtml(safe(c.modelVersion || 'версія не визначена', 24)) +
      ' · ' + escapeTelegramHtml(safe(c.memory || 'пам’ять не визначена', 24)) +
      '\n   ' + escapeTelegramHtml(safe(c.decision || 'рішення не визначено', 100))
    );
  }
  if (Number(data.cardsOmitted || 0) > 0) cards.push('Ще карток не показано: ' + Number(data.cardsOmitted));

  const errors = ['<b>Помилки</b>'];
  if (data.errors?.length) {
    for (const e of data.errors.slice(0, 5)) {
      errors.push('HTTP ' + escapeTelegramHtml(String(e.httpStatus ?? '—')) +
        ' · ' + escapeTelegramHtml(safe(e.code || e.message || 'помилка', 120)) +
        ' · антибот: ' + (e.antiBotDetected ? 'так' : 'ні'));
    }
  } else {
    errors.push('Зафіксованих помилок немає');
  }

  return splitTelegramMessages([header, pages.join('\n'), funnel, cards.join('\n'), errors.join('\n')]);
}

function formatStatusMessage(s = {}) {
  const webhook = s.webhook || {};
  const worker = s.worker || {};
  return [
    '<b>ЗНАЙДЕНО · Статус сервісу</b>',
    '<b>Коміт:</b> ' + escapeTelegramHtml(safe(s.commit || 'не доступний', 48)),
    '<b>Uptime:</b> ' + escapeTelegramHtml(safe(s.uptime || 'невідомо', 40)),
    '<b>Фоновий воркер:</b> останній успішний цикл ' +
      escapeTelegramHtml(safe(worker.lastSuccessAt || 'ще не зафіксовано', 48)) +
      ', фільтрів: ' + Number(worker.processedFilters || 0),
    '<b>Supabase:</b> ' + (s.supabaseOk ? 'доступна' : 'недоступна'),
    '<b>ENABLE_TEST_PREMIUM_BYPASS:</b> ' + (s.testPremiumBypassConfigured ? 'включён' : 'выключен') +
      ' · фактический обход: ' + (s.testPremiumBypassEffective ? 'разрешён' : 'заблокирован'),
    '<b>Telegram webhook:</b> host=' + escapeTelegramHtml(safe(webhook.host || 'не визначено', 120)) +
      ', pending=' + Number(webhook.pendingUpdates || 0),
    '<b>Остання помилка Telegram:</b> ' +
      escapeTelegramHtml(safe(webhook.lastError || 'немає', 220)),
    '<b>Останній запит OLX:</b> ' + escapeTelegramHtml(safe(s.lastOlxStatus || 'не зафіксовано', 100))
  ].join('\n');
}

module.exports = {
  consumeRateLimit,
  isAdminCommandAuthorized,
  splitTelegramMessages,
  formatDiagnosticMessages,
  formatStatusMessage
};
