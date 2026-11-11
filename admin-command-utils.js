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
    '<b>Категорія:</b> ' + escapeTelegramHtml(data.category === 'mobile_phones' ? 'Мобільні телефони' : data.category === 'accessories' ? 'Аксесуари' : 'Усі категорії') +
      ' · намір аксесуар: ' + (data.accessoryIntent ? 'так' : 'ні'),
    '<b>Модель:</b> ' + escapeTelegramHtml(safe(data.criteria?.model || 'не визначена', 40)) +
      ' · scope: ' + escapeTelegramHtml(safe(data.criteria?.modelScope || 'exact', 16)),
    '<b>Пагінація:</b> ' + escapeTelegramHtml(safe(data.stopReason || 'невідомо', 50))
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
  if (data.performance) {
    pages.push(
      '<b>Час та пам’ять</b>',
      'Завантаження: ' + Number(data.performance.loadMs || 0) + ' мс · розбір: ' +
        Number(data.performance.parseMs || 0) + ' мс · догрузка деталей: ' +
        Number(data.performance.detailsEnrichmentMs || 0) + ' мс · усього: ' +
        Number(data.performance.totalMs || 0) + ' мс',
      'Пік RSS: ' + (Number(data.performance.peakRssBytes || 0)
        ? Math.round(Number(data.performance.peakRssBytes) / 1048576) + ' МБ'
        : 'недоступний')
    );
  }

  const funnel = [
    '<b>Воронка</b>',
    'Розпарсено: ' + Number(f.parsed || 0) + ' → після усунення дублікатів: ' + Number(f.afterDedup || 0),
    'Місто: ' + Number(f.afterCity || 0) + ' → модель/версія: ' + Number(f.after_model ?? f.afterModel ?? 0) +
      ' · аксесуари відсіяні: ' + Number(f.accessoriesExcluded || 0),
    'Пам’ять: ' + Number(f.afterMemoryIncludingUnverified ?? f.after_memory ?? 0) +
      ' (не підтверджена: ' + Number(f.capacityUnverified || 0) + ')',
    'Виключення: ' + Number(f.after_excluded_words ?? 0),
    'Ціна: ' + Number(f.after_price ?? 0) + ' → стан: ' + Number(f.after_condition ?? 0),
    'Порядок конвеєра: ціна перед станом; класифікація рекомендацій OLX не інструментована.',
    'Версії у видачі: ' + Object.entries(f.versionCounts || {}).map(([version, count]) => version + ' ' + count).join(' · ' || '—') +
      '\n' + 'Підсумок: ' + Number(f.final || 0) +
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

function translateTelegramWebhookError(value) {
  const message = String(value || '');
  if (/429|too many requests/i.test(message)) return 'Webhook відповів HTTP 429: забагато запитів.';
  if (/401|unauthorized/i.test(message)) return 'Webhook відхилив запит (HTTP 401): перевірку секрету не пройдено.';
  if (/403|forbidden/i.test(message)) return 'Webhook відхилив запит (HTTP 403).';
  if (/502|bad gateway/i.test(message)) return 'Webhook повернув HTTP 502: помилка шлюзу.';
  if (/503|service unavailable/i.test(message)) return 'Webhook тимчасово недоступний (HTTP 503).';
  if (/500|internal server error/i.test(message)) return 'Webhook повернув HTTP 500: внутрішня помилка сервера.';
  const status = message.match(/\b([45]\d{2})\b/);
  return status
    ? 'Telegram повідомив про помилку webhook (HTTP ' + status[1] + ').'
    : 'Telegram повідомив про помилку webhook.';
}

function formatStatusMessage(s = {}) {
  const webhook = s.webhook || {};
  const worker = s.worker || {};
  return [
    '<b>ЗНАЙДЕНО · Статус сервісу</b>',
    '<b>Коміт:</b> ' + escapeTelegramHtml(safe(s.commit || 'недоступний', 48)),
    '<b>Час роботи:</b> ' + escapeTelegramHtml(safe(s.uptime || 'невідомо', 40)),
    '<b>Фоновий воркер:</b> останній успішний цикл ' +
      escapeTelegramHtml(safe(worker.lastSuccessAt || 'ще не зафіксовано', 48)) +
      ', фільтрів: ' + Number(worker.processedFilters || 0),
    '<b>Supabase:</b> ' + (s.supabaseOk ? 'доступна' : 'недоступна'),
    '<b>ENABLE_TEST_PREMIUM_BYPASS:</b> ' + (s.testPremiumBypassConfigured ? 'увімкнено' : 'вимкнено') +
      ' · фактичний обхід: ' + (s.testPremiumBypassEffective ? 'дозволено' : 'заблоковано'),
    '<b>Telegram webhook:</b> домен=' + escapeTelegramHtml(safe(webhook.host || 'не визначено', 120)) +
      ', очікують=' + Number(webhook.pendingUpdates || 0),
    '<b>Остання помилка Telegram:</b> ' +
      escapeTelegramHtml(safe(webhook.lastError || 'немає', 220)),
    '<b>Останній запит OLX:</b> ' + escapeTelegramHtml(safe(s.lastOlxStatus || 'не зафіксовано', 100))
  ].join('\n');
}


function maskTelegramId(value) {
  const digits = String(value ?? '').replace(/\\D/g, '');
  return digits ? '••••' + digits.slice(-4) : 'не визначено';
}

function formatSubscriptionMessage(data = {}) {
  const user = data.user || {};
  const access = data.access || {};
  const filters = data.filters || {};
  const lines = [
    '<b>ЗНАЙДЕНО · Підписка</b>',
    '<b>Telegram ID:</b> ' + escapeTelegramHtml(maskTelegramId(user.telegram_id)),
    '<b>Тариф зараз:</b> ' + escapeTelegramHtml(({ admin: 'Адміністратор', premium: 'Premium', trial: 'Пробний період', free: 'Безкоштовний' })[access.plan] || 'невідомо'),
    '<b>Початок пробного періоду:</b> ' + escapeTelegramHtml(user.trial_started_at || 'не починався'),
    '<b>Завершення пробного періоду:</b> ' + escapeTelegramHtml(access.trialEndsAt || 'немає'),
    '<b>Premium початок:</b> ' + escapeTelegramHtml(data.premiumStartedAt || 'не зберігається окремо в таблиці користувачів'),
    '<b>Premium до:</b> ' + escapeTelegramHtml(user.premium_until || 'немає'),
    '<b>Джерело:</b> ' + escapeTelegramHtml(data.grantSource || 'не визначено'),
    '<b>Ліміти:</b> фільтри ' + (Number.isFinite(access.filterLimit) ? access.filterLimit : 'без ліміту') +
      ', пошуки/день ' + (Number.isFinite(access.searchLimit) ? access.searchLimit : 'без ліміту') +
      ', інтервал ' + Number(access.checkIntervalMinutes || 0) + ' хв',
    '<b>Використано сьогодні:</b> ' + Number(data.searchesUsed || 0) +
      ' / ' + (Number.isFinite(access.searchLimit) ? access.searchLimit : 'без ліміту'),
    '<b>Фільтри:</b> всього ' + Number(filters.total || 0) +
      ', активні ' + Number(filters.active || 0) + ', призупинені лімітом ' + Number(filters.paused || 0),
    '<b>Після завершення:</b> ' + escapeTelegramHtml(data.expiryBehavior ||
      'Пробний період або Premium переходить на безкоштовний тариф; зайві фільтри залишаються в базі, але не обробляються фоновим процесом.')
  ];
  if (data.paymentEvidence) lines.push('<b>Платіжні записи:</b> ' + escapeTelegramHtml(data.paymentEvidence));
  return splitTelegramMessages([lines.join('\n')]);
}

function formatReferralMessage(data = {}) {
  const user = data.user || {};
  const lines = [
    '<b>ЗНАЙДЕНО · Реферали</b>',
    '<b>Telegram ID:</b> ' + escapeTelegramHtml(maskTelegramId(user.telegram_id)),
    '<b>Реферальний код:</b> ref_••••' + escapeTelegramHtml(String(user.telegram_id || '').slice(-4)),
    '<b>Хто запросив:</b> ' + escapeTelegramHtml(data.inviter ? maskTelegramId(data.inviter) : 'немає запису'),
    '<b>Запрошено:</b> ' + Number(data.invitedCount || 0),
    ...(data.invited || []).slice(0, 20).map((id, index) =>
      (index + 1) + '. ' + escapeTelegramHtml(maskTelegramId(id))),
    '<b>Попередні записи рефералів:</b> ' + Number(data.legacyInvitedCount || 0),
    ...(data.legacyInvited || []).slice(0, 20).map((id, index) =>
      'legacy ' + (index + 1) + '. ' + escapeTelegramHtml(maskTelegramId(id))),
    '<b>Начислення:</b> ' + Number(data.rewardedCount || 0) + ' × 3 дні = ' +
      Number(data.rewardedDays || 0) + ' днів за рефералів',
    '<b>Pending referrer:</b> ' + escapeTelegramHtml(data.pendingReferrer ? maskTelegramId(data.pendingReferrer) : 'немає'),
    '<b>Атрибуція:</b> ' + escapeTelegramHtml(user.referral_attributed_at || 'не зафіксована'),
    '<b>Розбіжності:</b> ' + escapeTelegramHtml((data.discrepancies || []).join('; ') || 'не виявлено')
  ];
  return splitTelegramMessages([lines.join('\n')]);
}
module.exports = {
  consumeRateLimit,
  isAdminCommandAuthorized,
  splitTelegramMessages,
  formatDiagnosticMessages,
  formatStatusMessage,
  translateTelegramWebhookError,
  maskTelegramId,
  formatSubscriptionMessage,
  formatReferralMessage
};
