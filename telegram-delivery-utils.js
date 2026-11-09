function getTelegramRetryDelaySeconds(error, maxSeconds = 30) {
  const retryAfter = Number(error?.response?.data?.parameters?.retry_after);
  if (!Number.isFinite(retryAfter)) return 1;
  return Math.min(maxSeconds, Math.max(1, Math.ceil(retryAfter)));
}

function isTelegramBlockedError(error) {
  return Number(error?.response?.status) === 403;
}

function isTelegramRateLimitError(error) {
  return Number(error?.response?.status) === 429;
}

module.exports = {
  getTelegramRetryDelaySeconds,
  isTelegramBlockedError,
  isTelegramRateLimitError
};
