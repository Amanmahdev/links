import { Hono } from 'hono';
import { fetchMetadata } from '../lib/metadata.js';

const router = new Hono();

// GET /api/metadata?url=https://...
// Called by upload.html when the user pastes a URL and clicks "Fetch Metadata".
// Worker proxies the request so the browser avoids CORS issues.
router.get('/', async (c) => {
  const url = c.req.query('url');

  if (!url) {
    return c.json({ error: 'url query param required' }, 400);
  }

  // Basic sanity — must be http/https
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return c.json({ error: 'Only http/https URLs are supported' }, 400);
    }
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  const meta = await fetchMetadata(url);
  return c.json(meta);
});

export default router;
