'use strict';

function stripOlxNonContentMarkup(input) {
  return String(input || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
}

module.exports = { stripOlxNonContentMarkup };
