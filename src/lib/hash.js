// SHA-256 of a normalised URL  →  hex string
// Used to guarantee one canonical row per URL (deduplication)
export async function hashURL(rawUrl) {
  const norm = rawUrl.trim().toLowerCase().replace(/\/+$/, '');
  const buf  = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(norm)
  );
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Extract e.g. "github.com" from any URL
export function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Hot score formula: time-decayed engagement
// weights: likes×4 + comments×3 + saves×2 + clicks×1
export function hotScore(likes, comments, saves, clicks, ageHours) {
  const interactions = likes * 4 + comments * 3 + saves * 2 + clicks;
  return interactions / Math.pow(ageHours + 2, 1.5);
}
