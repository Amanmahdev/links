// ============================================================
//  ENWEK WORKER  —  links.enwek.com
//  Cloudflare Workers + Hono + D1
//
//  Databases:
//    USERS_DB  — accounts, sessions, subscriptions, follows,
//                notifications, password_resets
//    LINKS_DB  — links, categories, likes, saves, clicks,
//                comments, comment_likes, reports, tags
//
//  Routes served:
//    GET  /api/categories            ← fetch.html & upload.html dropdowns
//    GET  /api/metadata?url=…        ← upload.html auto-fill
//    GET  /api/links/random          ← fetch.html shuffle
//    GET  /api/links                 ← paginated feed
//    GET  /api/links/:id             ← single link
//    POST /api/links                 ← upload.html single insert
//    POST /api/links/bulk            ← upload.html bulk insert
//    POST /api/links/:id/click       ← click tracking
//    POST /api/links/:id/like        ← toggle like
//    POST /api/links/:id/save        ← toggle save
//    GET  /api/comments/:linkId      ← link comments
//    POST /api/comments/:linkId      ← post comment
//    POST /api/auth/register         ← sign up
//    POST /api/auth/login            ← log in
//    POST /api/auth/logout           ← log out
//    GET  /api/auth/me               ← current user
//    POST /api/internal/refresh-scores ← cron score updater
//    GET  /health                    ← uptime check
// ============================================================

import { Hono }       from 'hono';
import { cors }        from 'hono/cors';
import { logger }      from 'hono/logger';
import { prettyJSON }  from 'hono/pretty-json';

import categoriesRouter from './routes/categories.js';
import metadataRouter   from './routes/metadata.js';
import linksRouter      from './routes/links.js';
import commentsRouter   from './routes/comments.js';
import authRouter       from './routes/auth.js';
import scoresRouter     from './routes/scores.js';

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────────
// Allows requests from enwek.com and any subdomain.
// Update ALLOWED_ORIGIN in wrangler.toml for staging / local.
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') || '';
  const allowed =
    origin === 'https://enwek.com'           ||
    origin.endsWith('.enwek.com')            ||
    origin === (c.env.ALLOWED_ORIGIN || '')  ||
    origin.startsWith('http://localhost')    ||  // dev convenience
    origin.startsWith('http://127.0.0.1');

  return cors({
    origin:         allowed ? origin : 'https://enwek.com',
    allowMethods:   ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders:   ['Content-Type', 'Authorization', 'X-Admin-Secret', 'X-Internal-Secret'],
    exposeHeaders:  ['Content-Length'],
    maxAge:         86400,
    credentials:    true,
  })(c, next);
});

// ── Dev helpers ───────────────────────────────────────────────
app.use('*', logger());
app.use('/api/*', prettyJSON());

// ── Health ────────────────────────────────────────────────────
app.get('/health', (c) => c.json({
  ok:      true,
  service: 'enwek-worker',
  ts:      new Date().toISOString(),
}));

// ── API routes ────────────────────────────────────────────────
app.route('/api/categories',        categoriesRouter);
app.route('/api/metadata',          metadataRouter);
app.route('/api/links',             linksRouter);
app.route('/api/comments',          commentsRouter);
app.route('/api/auth',              authRouter);
app.route('/api/internal',          scoresRouter);

// ── 404 ───────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

// ── Global error handler ──────────────────────────────────────
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ── Cron trigger — refreshes hot scores every hour ────────────
// Enable in wrangler.toml:
//   [triggers]
//   crons = ["0 * * * *"]
const scheduled = async (event, env, ctx) => {
  const { hotScore } = await import('./lib/hash.js');
  const DB  = env.LINKS_DB;
  const now = Date.now();

  try {
    const { results } = await DB.prepare(`
      SELECT id, like_count, comment_count, save_count, click_count, first_seen_at
      FROM   links
      WHERE  updated_at >= datetime('now', '-24 hours')
      AND    is_active = 1
    `).all();

    if (!results.length) return;

    const stmts = results.map(link => {
      const ageHours = (now - new Date(link.first_seen_at).getTime()) / 3_600_000;
      const score    = hotScore(
        link.like_count, link.comment_count,
        link.save_count, link.click_count,
        ageHours
      );
      return DB.prepare(`UPDATE links SET score = ? WHERE id = ?`).bind(score, link.id);
    });

    await DB.batch(stmts);
    console.log(`[cron] Refreshed scores for ${stmts.length} links`);

  } catch (err) {
    console.error('[cron] Score refresh failed:', err);
  }
};

// ── Export ────────────────────────────────────────────────────
export default {
  fetch:     app.fetch,
  scheduled,
};
