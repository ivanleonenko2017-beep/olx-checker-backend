'use strict';

const crypto = require('node:crypto');

function createWebhookQueueKey(secret) {
  const value = String(secret || '');
  if (!value) throw new Error('webhook_queue_secret_missing');
  return crypto.createHash('sha256')
    .update('znaideno-telegram-webhook-queue-v1:')
    .update(value)
    .digest();
}

function encryptTelegramUpdate(update, secret) {
  const key = createWebhookQueueKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(update), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptTelegramUpdate(payload, secret) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_webhook_queue_payload');
  const key = createWebhookQueueKey(secret);
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(clear);
}

function isValidTelegramWebhookSecret(received, expected) {
  const expectedValue = String(expected || '');
  const receivedBuffer = Buffer.from(String(received || ''));
  const expectedBuffer = Buffer.from(expectedValue);
  return Boolean(expectedValue) &&
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function isDuplicateWebhookUpdate(error) {
  return error?.code === '23505';
}

module.exports = {
  encryptTelegramUpdate,
  decryptTelegramUpdate,
  isValidTelegramWebhookSecret,
  isDuplicateWebhookUpdate
};
