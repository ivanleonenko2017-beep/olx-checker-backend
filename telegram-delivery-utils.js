'use strict';

const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 60;

function getTelegramRetryDelaySeconds(error) {
  const raw = Number(error?.response?.data?.parameters?.retry_after);
  if (!Number.isFinite(raw) || raw <= 0) return MIN_RETRY_SECONDS;
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, Math.ceil(raw)));
}

function isTelegramBlockedError(error) {
  return Number(error?.response?.status) === 403;
}

module.exports = {
  getTelegramRetryDelaySeconds,
  isTelegramBlockedError,
  MIN_RETRY_SECONDS,
  MAX_RETRY_SECONDS
};
