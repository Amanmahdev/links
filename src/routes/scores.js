import { Hono } from 'hono';
import { hotScore } from '../lib/hash.js';

const router = new Hono();

// POST /api/internal/refresh-scores
// Protected by X-Internal-Secret header (set ADMIN_SECRET in wrangler).
// Called by Cloudflare Cron Trigger every hour to recalculate hot scores.
//
// Add to wrangler.toml:
//   [triggers]
//   crons = ["0 * * * *"]
//
// Then in your default export scheduled handler call this logic.
router.post('/refresh-scores', async (c) => {
  const secret = c.req.header('X-Internal-Secret');
  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const DB  = c.env.LINKS_DB;
  const now = Date.now();

  // Only recalculate links active in the last 24 hours (saves 85% of scan)
  const { results: links } = await DB.prepare(`
    SELECT id, like_count, comment_count, save_count, click_count, first_seen_at
    FROM   links
    WHERE  updated_at >= datetime('now', '-24 hours')
    AND    is_active = 1
  `).all();

  if (!links.length) return c.json({ ok: true, updated: 0 });

  const stmts = links.map(link => {
    const ageHours = (now - new Date(link.first_seen_at).getTime()) / 3_600_000;
    const score    = hotScore(
      link.like_count, link.comment_count,
      link.save_count, link.click_count,
      ageHours
    );
    return DB.prepare(`UPDATE links SET score = ? WHERE id = ?`).bind(score, link.id);
  });

  await DB.batch(stmts);
  return c.json({ ok: true, updated: links.length });
});

export default router;
