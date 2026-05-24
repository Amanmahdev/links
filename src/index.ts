/**
 * ENWEK — Cloudflare Worker  (Hono + D1)
 *
 * Routes
 * ──────────────────────────────────────────────────────────────
 *  GET  /api/metadata?url=<url>          Scrape OG / meta tags
 *  POST /api/links                       Insert one link
 *  POST /api/links/bulk                  Insert many links (admin)
 *  GET  /api/links/random                Pick N random active links
 *  GET  /api/links/random?category=slug  Random inside a category
 *  GET  /api/links/:id                   Single link by ID
 *  GET  /api/categories                  List all categories
 * ──────────────────────────────────────────────────────────────
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

// ──────────────────────────── types ────────────────────────────

export interface Env {
  DB: D1Database;
  ADMIN_SECRET: string;
}

interface LinkRow {
  id: string;
  url: string;
  domain: string | null;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  format: string;
  category_id: string | null;
  like_count: number;
  comment_count: number;
  save_count: number;
  click_count: number;
  score: number;
  is_active: number;
  first_seen_at: string;
}

// ────────────────────────── nanoid lite ─────────────────────────
// Cloudflare Workers support crypto.getRandomValues, so we use
// a tiny inline nanoid to avoid the npm package edge-compat issues.

const ALPHABET =
  'ModuleSymbolhasOwnProperty0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function nanoid(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes)
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');
}

// ────────────────────────── helpers ─────────────────────────────

/** SHA-256 hex of a string (used as url_hash) */
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.toLowerCase().trim());
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Extract hostname from a URL string */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Detect format from URL / content type */
function detectFormat(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be') || lower.includes('vimeo'))
    return 'video';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (
    lower.endsWith('.exe') ||
    lower.endsWith('.dmg') ||
    lower.endsWith('.apk') ||
    lower.includes('/download/')
  )
    return 'software';
  return 'page';
}

/** Scrape OG / meta data from a URL */
async function fetchMetadata(
  url: string,
): Promise<{ title: string; description: string; thumbnail: string; domain: string }> {
  const result = { title: '', description: '', thumbnail: '', domain: extractDomain(url) };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EnwekBot/1.0 (+https://enwek.com)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();

    const getMeta = (prop: string): string => {
      const patterns = [
        new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'),
        new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${prop}["']`, 'i'),
      ];
      for (const p of patterns) {
        const m = html.match(p);
        if (m?.[1]) return m[1].trim();
      }
      return '';
    };

    result.title =
      getMeta('title') ||
      (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? '').trim();
    result.description = getMeta('description');
    result.thumbnail = getMeta('image');
  } catch {
    // silently fail — caller still gets domain
  }
  return result;
}

// ──────────────────────────── app ───────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());
app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Admin-Secret'],
  }),
);

// ── GET /api/metadata ────────────────────────────────────────────
app.get('/api/metadata', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'url query param required' }, 400);

  try {
    new URL(url); // validate
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  const meta = await fetchMetadata(url);
  return c.json({ ...meta, format: detectFormat(url) });
});

// ── GET /api/categories ──────────────────────────────────────────
app.get('/api/categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, slug, link_count
     FROM categories
     ORDER BY display_order`,
  ).all();
  return c.json(results);
});

// ── POST /api/links  (single insert) ────────────────────────────
app.post('/api/links', async (c) => {
  let body: {
    url?: string;
    category_id?: string;
    title?: string;
    description?: string;
    thumbnail?: string;
    submitted_by?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const url = (body.url ?? '').trim();
  if (!url) return c.json({ error: 'url is required' }, 400);

  try {
    new URL(url);
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  const urlHash = await sha256(url);

  // Deduplicate
  const existing = await c.env.DB.prepare(
    `SELECT id FROM links WHERE url_hash = ?`,
  )
    .bind(urlHash)
    .first<{ id: string }>();

  if (existing) {
    return c.json({ success: true, id: existing.id, duplicate: true });
  }

  // Auto-fetch metadata if not provided
  let { title = '', description = '', thumbnail = '' } = body;
  if (!title) {
    const meta = await fetchMetadata(url);
    title = meta.title;
    description = description || meta.description;
    thumbnail = thumbnail || meta.thumbnail;
  }

  const id = nanoid();
  const domain = extractDomain(url);
  const format = detectFormat(url);

  await c.env.DB.prepare(
    `INSERT INTO links (id, url, url_hash, domain, title, description, thumbnail_url, format, category_id, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      url,
      urlHash,
      domain,
      title,
      description,
      thumbnail,
      format,
      body.category_id ?? null,
      body.submitted_by ?? null,
    )
    .run();

  return c.json({ success: true, id }, 201);
});

// ── POST /api/links/bulk  (admin mass-insert) ────────────────────
app.post('/api/links/bulk', async (c) => {
  // Lightweight admin guard
  const secret = c.req.header('X-Admin-Secret');
  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let body: { links?: Array<{ url: string; category_id?: string; title?: string; description?: string; thumbnail?: string }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const items = body.links ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    return c.json({ error: 'links array required' }, 400);
  }
  if (items.length > 500) {
    return c.json({ error: 'Max 500 links per request' }, 400);
  }

  const results: { url: string; id?: string; error?: string; duplicate?: boolean }[] = [];

  for (const item of items) {
    const url = (item.url ?? '').trim();
    if (!url) {
      results.push({ url: '', error: 'empty url' });
      continue;
    }
    try {
      new URL(url);
    } catch {
      results.push({ url, error: 'Invalid URL' });
      continue;
    }

    try {
      const urlHash = await sha256(url);
      const existing = await c.env.DB.prepare(`SELECT id FROM links WHERE url_hash = ?`)
        .bind(urlHash)
        .first<{ id: string }>();

      if (existing) {
        results.push({ url, id: existing.id, duplicate: true });
        continue;
      }

      let { title = '', description = '', thumbnail = '' } = item;
      if (!title) {
        const meta = await fetchMetadata(url);
        title = meta.title;
        description = description || meta.description;
        thumbnail = thumbnail || meta.thumbnail;
      }

      const id = nanoid();
      const domain = extractDomain(url);
      const format = detectFormat(url);

      await c.env.DB.prepare(
        `INSERT INTO links (id, url, url_hash, domain, title, description, thumbnail_url, format, category_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, url, urlHash, domain, title, description, thumbnail, format, item.category_id ?? null)
        .run();

      results.push({ url, id });
    } catch (err) {
      results.push({ url, error: String(err) });
    }
  }

  const inserted = results.filter((r) => r.id && !r.duplicate).length;
  const duplicates = results.filter((r) => r.duplicate).length;
  const errors = results.filter((r) => r.error && !r.duplicate).length;

  return c.json({ success: true, inserted, duplicates, errors, results }, 201);
});

// ── GET /api/links/random ────────────────────────────────────────
app.get('/api/links/random', async (c) => {
  const count = Math.min(Number(c.req.query('count') ?? '1'), 50);
  const category = c.req.query('category'); // optional category slug
  const format = c.req.query('format');     // optional format filter

  let sql = `
    SELECT
      l.id, l.url, l.domain, l.title, l.description, l.thumbnail_url,
      l.format, l.category_id, l.like_count, l.comment_count,
      l.save_count, l.click_count, l.score, l.first_seen_at,
      c.name AS category_name, c.slug AS category_slug
    FROM links l
    LEFT JOIN categories c ON c.id = l.category_id
    WHERE l.is_active = 1
  `;

  const params: (string | number)[] = [];

  if (category) {
    sql += ` AND c.slug = ?`;
    params.push(category);
  }
  if (format) {
    sql += ` AND l.format = ?`;
    params.push(format);
  }

  sql += ` ORDER BY RANDOM() LIMIT ?`;
  params.push(count);

  const stmt = c.env.DB.prepare(sql).bind(...params);
  const { results } = await stmt.all<LinkRow & { category_name: string; category_slug: string }>();

  return c.json({ count: results.length, links: results });
});

// ── GET /api/links/:id ───────────────────────────────────────────
app.get('/api/links/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT l.*, c.name AS category_name, c.slug AS category_slug
     FROM links l
     LEFT JOIN categories c ON c.id = l.category_id
     WHERE l.id = ? AND l.is_active = 1`,
  )
    .bind(id)
    .first();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

export default app;
