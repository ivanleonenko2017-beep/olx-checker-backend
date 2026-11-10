'use strict';

function hasNegotiablePrice(value) {
  return /договірна(?:\s+ціна)?|negotiable/iu.test(String(value || ''));
}

function cleanOlxCardTitle(rawTitle, rawPriceText = '') {
  let title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!title) return '';

  const sourcePrice = String(rawPriceText || '');
  const amountMatch = sourcePrice.match(/\d[\d\s\u00a0.,]*/u);
  const hasCurrency = /грн|₴/iu.test(sourcePrice);
  if (amountMatch && hasCurrency) {
    const digits = amountMatch[0].replace(/\D/g, '');
    if (digits) {
      const amountPattern = digits.split('').join('[\\s\\u00a0]*');
      const suffix = new RegExp(
        '[\\s\\u00a0]*' + amountPattern +
        '[\\s\\u00a0]*(?:грн|₴)[.,]?' +
        '(?:[\\s\\u00a0]*[.,·-]?[\\s\\u00a0]*(?:договірна(?:[\\s\\u00a0]+ціна)?|negotiable))?\\s*$',
        'iu'
      );
      title = title.replace(suffix, '').trim();
    }
  } else {
    title = title.replace(
      /[\s\u00a0]*\d[\d\s\u00a0.,]*[\s\u00a0]*(?:грн|₴)[\s\u00a0]*(?:[.,·-]?[\s\u00a0]*(?:договірна(?:[\s\u00a0]+ціна)?|negotiable))?\s*$/iu,
      ''
    ).trim();
  }

  if (hasNegotiablePrice(sourcePrice)) {
    title = title.replace(/[\s\u00a0]*[.,·-]?[\s\u00a0]*договірна(?:[\s\u00a0]+ціна)?\s*$/iu, '').trim();
  }
  return title.replace(/[\s\u00a0|/·,;:.-]+$/u, '').trim();
}

module.exports = { cleanOlxCardTitle, hasNegotiablePrice };
