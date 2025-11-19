// utils.js
// Small helpers used by content_script and service_worker

/**
 * Extract domain from URL (host only)
 * @param {string} url
 * @returns {string}
 */
function getDomain(url) {
  try {
    const u = new URL(url, window.location.href);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * Simple fuzzy check: how similar is `a` to `b` based on trigram overlap / ratio.
 * Lightweight approximate string similarity (0..1).
 */
function simpleSimilarity(a = '', b = '') {
  a = (a || '').toLowerCase();
  b = (b || '').toLowerCase();
  if (!a.length || !b.length) return 0;
  // character-level common subsequence ratio (fast approximate)
  let common = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) common++;
  }
  return common / Math.max(a.length, b.length);
}

/**
 * Known brand keywords we consider high-risk impersonation targets.
 */
const KNOWN_BRANDS = [
  { name: 'instagram', keywords: ['instagram', 'insta', 'meta'] },
  { name: 'facebook', keywords: ['facebook', 'fb', 'meta'] },
  { name: 'gmail', keywords: ['gmail', 'google', 'google accounts', 'sign in'] }
];

function looksLikeBrand(document) {
  // Check page title and meta tags, as well as visible images' alt/title attributes for brand keywords
  const title = (document.title || '').toLowerCase();
  const meta = Array.from(document.getElementsByTagName('meta')).map(m => (m.content || '').toLowerCase());
  const imgs = Array.from(document.getElementsByTagName('img')).slice(0, 30); // limit
  const imgTexts = imgs.map(i => ((i.alt || '') + ' ' + (i.title || '')).toLowerCase());
  const textPool = [title, ...meta, ...imgTexts].join(' ');
  for (const brand of KNOWN_BRANDS) {
    for (const kw of brand.keywords) {
      if (textPool.includes(kw)) return brand.name;
    }
  }
  return null;
}
