/**
 * The controller routes for the CCC template and export.
 */
const { buildCccTemplateBuffer, parseCccMatrixFile } = require('../utils/excel/ccc');
const { buildCccTemplatePayload, cccTemplateBanner } = require('../services/cccTemplateService');
const { buildCccPdf } = require('../utils/pdf/matrix');
const db = require('../config/db');
const LongitudinalService = require('../services/longitudinalService');

// Helper to fuzzy-match names
function normalizeName(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^dr\.\s*/, '')
    .replace(/\./g, '')
    .replace(/[-’']/g, '')
    .replace(/\s+/g, ' ');
}

function tokens(text) {
  return normalizeName(text).split(' ').filter(Boolean);
}

function nameDistance(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (na === nb) return 0;
  const ta = tokens(a), tb = tokens(b);
  let matches = 0;
  for (const t of ta) if (tb.includes(t)) matches++;
  for (const t of tb) if (ta.includes(t)) matches++;
  const base = Math.max(ta.length, tb.length) || 1;
  return 1 - (matches / base);
}

/**
 * The closest candidate to `query` whose token distance is within tolerance,
 * or null. (An earlier `bestMatch(map, candidates)` overload of this name was
 * shadowed by this declaration — it never ran — so it is gone rather than kept
 * as a trap for the next caller.)
 */
function bestMatch(query, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates || []) {
    if (!c) continue;
    const d = nameDistance(query, c);
    if (d < bestScore - 1e-9) {
      bestScore = d;
      best = c;
      if (bestScore === 0) break;
    }
  }
  if (!best || bestScore > 0.4) return null;
  return best;
}

module.exports = {
  normalizeName,
  tokens,
  nameDistance,
  bestMatch,
};

