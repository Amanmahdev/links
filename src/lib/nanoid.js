// Tiny nanoid replacement — uses Web Crypto, works in Cloudflare Workers
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export function nanoid(size = 21) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, b => ALPHABET[b & 63]).join('');
}
