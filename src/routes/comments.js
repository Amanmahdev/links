import { Hono } from 'hono';
import { nanoid } from '../lib/nanoid.js';

const router = new Hono();

// GET /api/comments/:linkId   — top-level + replies for a link
router.get('/:linkId', async (c) => {
  const DB     = c.env.LINKS_DB;
  const linkId = c.req.param('linkId');
  const page   = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit  = 20;
  const offset = (page - 1) * limit;

  try {
    const { results } = await DB.prepare(`
      SELECT
        cm.id, cm.body, cm.like_count, cm.reply_count,
        cm.parent_id, cm.created_at, cm.is_deleted,
        acc.id       AS author_id,
        acc.username AS author_username,
        acc.avatar_url AS author_avatar
      FROM  comments cm
      JOIN  accounts acc ON acc.id = cm.user_id
      WHERE cm.link_id = ? AND cm.is_deleted = 0
      ORDER BY cm.like_count DESC, cm.created_at ASC
      LIMIT ? OFFSET ?
    `).bind(linkId, limit, offset).all();

    return c.json({ comments: results, page });

  } catch (err) {
    console.error('comments GET:', err);
    return c.json({ error: 'Failed to load comments', comments: [] }, 500);
  }
});

// POST /api/comments/:linkId
// Body: { user_id, body, parent_id? }
router.post('/:linkId', async (c) => {
  const DB     = c.env.LINKS_DB;
  const linkId = c.req.param('linkId');
  const body   = await c.req.json().catch(() => null);

  if (!body?.user_id || !body?.body?.trim()) {
    return c.json({ error: 'user_id and body are required' }, 400);
  }

  const id = nanoid();
  try {
    await DB.prepare(`
      INSERT INTO comments (id, link_id, user_id, parent_id, body)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, linkId, body.user_id, body.parent_id || null, body.body.trim()).run();

    const comment = await DB.prepare(`
      SELECT cm.*, acc.username AS author_username, acc.avatar_url AS author_avatar
      FROM   comments cm
      JOIN   accounts acc ON acc.id = cm.user_id
      WHERE  cm.id = ?
    `).bind(id).first();

    return c.json({ ok: true, comment }, 201);

  } catch (err) {
    console.error('comments POST:', err);
    return c.json({ error: err.message || 'Failed to post comment' }, 500);
  }
});

export default router;
