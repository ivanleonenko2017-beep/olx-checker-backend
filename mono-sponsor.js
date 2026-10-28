'use strict';

function parseSponsorTelegramId(comment) {
  const value = String(comment || '').trim();
  // Require the entire comment to be a positive Telegram numeric ID.
  if (!/^\d{1,20}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeMonobankTransaction(transaction, jarId) {
  if (!transaction || typeof transaction.id !== 'string' || !transaction.id.trim()) return null;
  const telegramId = parseSponsorTelegramId(transaction.comment);
  const amountMinor = Number(transaction.amount);
  const time = Number(transaction.time);
  if (!telegramId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      !Number.isSafeInteger(time) || time <= 0) return null;

  return {
    mono_transaction_id: transaction.id.trim(),
    telegram_id: telegramId,
    jar_id: String(jarId),
    amount_minor: amountMinor,
    currency_code: Number.isSafeInteger(Number(transaction.currencyCode)) ? Number(transaction.currencyCode) : null,
    comment: String(transaction.comment).trim(),
    occurred_at: new Date(time * 1000).toISOString()
  };
}

module.exports = { parseSponsorTelegramId, normalizeMonobankTransaction };
