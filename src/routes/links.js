import { Hono } from 'hono';
import { nanoid }        from '../lib/nanoid.js';
import { hashURL, extractDomain } from '../lib/hash.js';
import { fetchMetadata } from '../lib/metadata.js';

const router = new Hono();

const VALID_FORMATS = new Set(['page', 'video', 'pdf', 'software', 'other']);


// ─────────────────────────────────────────────────────────────
//  GET /api/links/random
// ─────────────────────────────────────────────────────────────
router.get('/random', async (c) => {
  const DB = c.env.LINKS_DB;

  const count    = Math.min(48, Math.max(1, parseInt(c.req.query('count') || '12')));
  const category = c.req.query('category') || '';
  const format   = c.req.query('format')   || '';

  const conditions = ['l.is_active = 1'];
  const params     = [];

  if (category) { conditions.push(`cat.slug = ?`); params.push(category); }
  if (format && VALID_FORMATS.has(format)) { conditions.push(`l.format = ?`); params.push(format); }

  try {
    const { results } = await DB.prepare(`
      SELECT
        l.id, l.url, l.title, l.description, l.thumbnail_url,
        l.format, l.domain,
        l.like_count, l.comment_count, l.save_count, l.click_count,
        l.score, l.first_seen_at,
        cat.name AS category_name,
        cat.slug AS category_slug
      FROM  links l
      LEFT  JOIN categories cat ON cat.id = l.category_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY RANDOM()
      LIMIT ?
    `).bind(...params, count).all();

    return c.json({ links: results, count: results.length });

  } catch (err) {
    console.error('links/random GET:', err);
    return c.json({ error: 'Failed to fetch links', links: [] }, 500);
  }
});


// ─────────────────────────────────────────────────────────────
//  GET /api/links  (paginated feed)
// ─────────────────────────────────────────────────────────────
router.get('/', async (c) => {
  const DB = c.env.LINKS_DB;

  const page   = Math.max(1, parseInt(c.req.query('page')  || '1'));
  const limit  = Math.min(48, Math.max(1, parseInt(c.req.query('limit') || '12')));
  const offset = (page - 1) * limit;
  const sort   = c.req.query('sort')     || 'hot';
  const cat    = c.req.query('category') || '';
  const fmt    = c.req.query('format')   || '';

  const orderCol =
    sort === 'new' ? 'l.first_seen_at DESC' :
    sort === 'top' ? 'l.like_count DESC'    :
                     'l.score DESC';

  const conditions = ['l.is_active = 1'];
  const params     = [];

  if (cat) { conditions.push(`cat.slug = ?`); params.push(cat); }
  if (fmt && VALID_FORMATS.has(fmt)) { conditions.push(`l.format = ?`); params.push(fmt); }

  try {
    const { results } = await DB.prepare(`
      SELECT
        l.id, l.url, l.title, l.description, l.thumbnail_url,
        l.format, l.domain,
        l.like_count, l.comment_count, l.save_count, l.click_count,
        l.score, l.first_seen_at,
        cat.name AS category_name,
        cat.slug AS category_slug
      FROM  links l
      LEFT  JOIN categories cat ON cat.id = l.category_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderCol}
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    return c.json({ links: results, page, limit, count: results.length });

  } catch (err) {
    console.error('links GET:', err);
    return c.json({ error: 'Failed to fetch links', links: [] }, 500);
  }
});


// ─────────────────────────────────────────────────────────────
//  POST /api/links  (single insert)
// ─────────────────────────────────────────────────────────────
router.post('/', async (c) => {
  const DB   = c.env.LINKS_DB;
  const body = await c.req.json().catch(() => null);

  if (!body?.url) return c.json({ error: 'url is required' }, 400);

  const rawUrl = body.url.trim();
  try { new URL(rawUrl); } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  const urlHash = await hashURL(rawUrl);
  const domain  = extractDomain(rawUrl);
  const format  = VALID_FORMATS.has(body.format) ? body.format : 'page';

  // Deduplication
  const existing = await DB.prepare(
    `SELECT id, title, format, like_count, comment_count, score FROM links WHERE url_hash = ?`
  ).bind(urlHash).first();

  if (existing) {
    return c.json({ success: true, duplicate: true, id: existing.id, link: existing });
  }

  // BUG 2 FIX — upload.html sends body.thumbnail but worker destructured as body.thumbnail_url
  // Correctly read whichever field is present
  let title         = body.title        || '';
  let description   = body.description  || '';
  let thumbnail_url = body.thumbnail_url || body.thumbnail || '';

  if (!title) {
    try {
      const meta = await fetchMetadata(rawUrl);
      title         = meta.title       || rawUrl;
      description   = description || meta.description || '';
      thumbnail_url = thumbnail_url   || meta.thumbnail  || '';
    } catch {
      title = rawUrl;
    }
  }

  const id = nanoid();

  try {
    await DB.prepare(`
      INSERT INTO links
        (id, url, url_hash, domain, title, description, thumbnail_url,
         format, category_id, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      rawUrl,
      urlHash,
      domain,
      title       || rawUrl,
      description || '',
      thumbnail_url || '',
      format,
      body.category_id  || null,
      body.submitted_by || 'enwek_team_official_xx'
    ).run();

    const inserted = await DB.prepare(`SELECT * FROM links WHERE id = ?`).bind(id).first();
    return c.json({ success: true, duplicate: false, id, link: inserted }, 201);

  } catch (err) {
    console.error('links POST:', err);
    return c.json({ error: err.message || 'Insert failed' }, 500);
  }
});


// ─────────────────────────────────────────────────────────────
//  POST /api/links/bulk
//  BUG 1 FIX — must be registered BEFORE /:id routes
//  otherwise Hono matches "bulk" as an :id parameter
// ─────────────────────────────────────────────────────────────
router.post('/bulk', async (c) => {
  const secret = c.req.header('X-Admin-Secret');
  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'Unauthorized — invalid or missing Admin Secret' }, 401);
  }

  const DB   = c.env.LINKS_DB;
  const body = await c.req.json().catch(() => null);

  if (!Array.isArray(body?.links) || body.links.length === 0) {
    return c.json({ error: 'links array is required and must not be empty' }, 400);
  }

  const batch   = body.links.slice(0, 100);
  const results = [];

  for (const item of batch) {
    const rawUrl = (item.url || '').trim();
    if (!rawUrl) { results.push({ url: '', error: 'empty url', duplicate: false }); continue; }

    try { new URL(rawUrl); } catch {
      results.push({ url: rawUrl, error: 'invalid url', duplicate: false }); continue;
    }

    try {
      const urlHash = await hashURL(rawUrl);
      const domain  = extractDomain(rawUrl);

      const existing = await DB.prepare(
        `SELECT id FROM links WHERE url_hash = ?`
      ).bind(urlHash).first();

      if (existing) {
        results.push({ url: rawUrl, id: existing.id, duplicate: true });
        continue;
      }

      let title = '', description = '', thumbnail_url = '';
      try {
        const meta = await fetchMetadata(rawUrl);
        title         = meta.title       || rawUrl;
        description   = meta.description || '';
        thumbnail_url = meta.thumbnail   || '';
      } catch {
        title = rawUrl;
      }

      const id = nanoid();
      await DB.prepare(`
        INSERT INTO links
          (id, url, url_hash, domain, title, description, thumbnail_url,
           format, category_id, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        rawUrl,
        urlHash,
        domain,
        title,
        description,
        thumbnail_url,
        item.format && VALID_FORMATS.has(item.format) ? item.format : 'page',
        item.category_id  || null,
        item.submitted_by || 'enwek_team_official_xx'
      ).run();

      results.push({ url: rawUrl, id, duplicate: false });

    } catch (err) {
      console.error('bulk item error:', rawUrl, err);
      results.push({ url: rawUrl, error: err.message || 'insert failed', duplicate: false });
    }
  }

  return c.json({
    results,
    inserted:   results.filter(r => !r.duplicate && !r.error).length,
    duplicates: results.filter(r =>  r.duplicate).length,
    errors:     results.filter(r =>  r.error).length,
  });
});


// ─────────────────────────────────────────────────────────────
//  GET /api/links/:id  — single link detail
//  BUG 1 FIX — kept AFTER all static POST routes
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (c) => {
  const DB = c.env.LINKS_DB;
  const id = c.req.param('id');

  try {
    const link = await DB.prepare(`
      SELECT l.*, cat.name AS category_name, cat.slug AS category_slug
      FROM   links l
      LEFT   JOIN categories cat ON cat.id = l.category_id
      WHERE  l.id = ? AND l.is_active = 1
    `).bind(id).first();

    if (!link) return c.json({ error: 'Not found' }, 404);
    return c.json(link);

  } catch (err) {
    console.error('links/:id GET:', err);
    return c.json({ error: 'Failed to fetch link' }, 500);
  }
});


// ─────────────────────────────────────────────────────────────
//  POST /api/links/:id/click
// ─────────────────────────────────────────────────────────────
router.post('/:id/click', async (c) => {
  const DB   = c.env.LINKS_DB;
  const id   = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  // BUG 3 FIX — schema has ip_hash column, include it from CF header
  const ipRaw  = c.req.header('cf-connecting-ip') || '';
  let   ipHash = '';
  if (ipRaw) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ipRaw));
    ipHash = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2,'0')).join('');
  }

  try {
    await DB.prepare(
      `INSERT INTO clicks (link_id, user_id, ip_hash) VALUES (?, ?, ?)`
    ).bind(id, body.user_id || null, ipHash || null).run();

    return c.json({ ok: true });
  } catch (err) {
    console.error('click POST:', err);
    return c.json({ error: 'Failed to record click' }, 500);
  }
});


// ─────────────────────────────────────────────────────────────
//  POST /api/links/:id/like  (toggle)
// ─────────────────────────────────────────────────────────────
router.post('/:id/like', async (c) => {
  const DB   = c.env.LINKS_DB;
  const id   = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const uid  = body.user_id;

  if (!uid) return c.json({ error: 'user_id required' }, 400);

  try {
    const existing = await DB.prepare(
      `SELECT id FROM likes WHERE link_id = ? AND user_id = ?`
    ).bind(id, uid).first();

    if (existing) {
      await DB.prepare(`DELETE FROM likes WHERE link_id = ? AND user_id = ?`).bind(id, uid).run();
      return c.json({ ok: true, liked: false });
    }

    await DB.prepare(
      `INSERT INTO likes (id, link_id, user_id) VALUES (?, ?, ?)`
    ).bind(nanoid(), id, uid).run();

    return c.json({ ok: true, liked: true });

  } catch (err) {
    console.error('like POST:', err);
    return c.json({ error: 'Failed to toggle like' }, 500);
  }
});


// ─────────────────────────────────────────────────────────────
//  POST /api/links/:id/save  (toggle)
// ─────────────────────────────────────────────────────────────
router.post('/:id/save', async (c) => {
  const DB   = c.env.LINKS_DB;
  const id   = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const uid  = body.user_id;

  if (!uid) return c.json({ error: 'user_id required' }, 400);

  try {
    const existing = await DB.prepare(
      `SELECT id FROM saves WHERE link_id = ? AND user_id = ?`
    ).bind(id, uid).first();

    if (existing) {
      await DB.prepare(`DELETE FROM saves WHERE link_id = ? AND user_id = ?`).bind(id, uid).run();
      return c.json({ ok: true, saved: false });
    }

    await DB.prepare(
      `INSERT INTO saves (id, link_id, user_id, collection) VALUES (?, ?, ?, ?)`
    ).bind(nanoid(), id, uid, body.collection || 'default').run();

    return c.json({ ok: true, saved: true });

  } catch (err) {
    console.error('save POST:', err);
    return c.json({ error: 'Failed to toggle save' }, 500);
  }
});

export default router;
