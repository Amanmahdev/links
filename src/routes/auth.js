import { Hono } from 'hono';
import { nanoid } from '../lib/nanoid.js';

const router = new Hono();

// ── tiny password hasher (SHA-256 based) ──────────────────────
// In production consider using bcrypt via a Durable Object or
// a dedicated hashing service. Workers have no native bcrypt.
async function hashPassword(password) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(password + 'enwek-salt-v1')
  );
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function sessionExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + 30); // 30-day sessions
  return d.toISOString();
}


// ─────────────────────────────────────────────────────────────
//  POST /api/auth/register
//  Body: { email, username, password, full_name? }
// ─────────────────────────────────────────────────────────────
router.post('/register', async (c) => {
  const DB   = c.env.USERS_DB;
  const body = await c.req.json().catch(() => null);

  if (!body?.email || !body?.username || !body?.password) {
    return c.json({ error: 'email, username, and password are required' }, 400);
  }

  const email    = body.email.trim().toLowerCase();
  const username = body.username.trim().toLowerCase();

  // Check uniqueness
  const taken = await DB.prepare(
    `SELECT id FROM accounts WHERE email = ? OR username = ?`
  ).bind(email, username).first();

  if (taken) {
    return c.json({ error: 'Email or username already taken' }, 409);
  }

  const id            = nanoid();
  const password_hash = await hashPassword(body.password);

  try {
    await DB.prepare(`
      INSERT INTO accounts (id, email, username, full_name, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, email, username, body.full_name || null, password_hash).run();

    // Create session immediately
    const sessionId = nanoid(32);
    await DB.prepare(`
      INSERT INTO sessions (session_id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).bind(sessionId, id, sessionExpiry()).run();

    return c.json({
      ok: true,
      session_id: sessionId,
      user: { id, email, username, role: 'user', plan: 'free' }
    }, 201);

  } catch (err) {
    console.error('register POST:', err);
    return c.json({ error: err.message || 'Registration failed' }, 500);
  }
});


// ─────────────────────────────────────────────────────────────
//  POST /api/auth/login
//  Body: { email, password }
// ─────────────────────────────────────────────────────────────
router.post('/login', async (c) => {
  const DB   = c.env.USERS_DB;
  const body = await c.req.json().catch(() => null);

  if (!body?.email || !body?.password) {
    return c.json({ error: 'email and password are required' }, 400);
  }

  const email         = body.email.trim().toLowerCase();
  const password_hash = await hashPassword(body.password);

  const user = await DB.prepare(
    `SELECT id, email, username, role, plan, is_active
     FROM   accounts
     WHERE  email = ? AND password_hash = ?`
  ).bind(email, password_hash).first();

  if (!user) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  if (!user.is_active) {
    return c.json({ error: 'Account is suspended' }, 403);
  }

  // Update last_login_at
  await DB.prepare(
    `UPDATE accounts SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(user.id).run();

  const sessionId = nanoid(32);
  await DB.prepare(`
    INSERT INTO sessions (session_id, user_id, ip_address, user_agent, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    sessionId,
    user.id,
    c.req.header('cf-connecting-ip') || '',
    c.req.header('user-agent') || '',
    sessionExpiry()
  ).run();

  return c.json({
    ok: true,
    session_id: sessionId,
    user: { id: user.id, email: user.email, username: user.username, role: user.role, plan: user.plan }
  });
});


// ─────────────────────────────────────────────────────────────
//  POST /api/auth/logout
//  Header: Authorization: Bearer <session_id>
// ─────────────────────────────────────────────────────────────
router.post('/logout', async (c) => {
  const DB        = c.env.USERS_DB;
  const sessionId = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();

  if (!sessionId) return c.json({ ok: true });

  await DB.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sessionId).run().catch(() => {});
  return c.json({ ok: true });
});


// ─────────────────────────────────────────────────────────────
//  GET /api/auth/me
//  Header: Authorization: Bearer <session_id>
// ─────────────────────────────────────────────────────────────
router.get('/me', async (c) => {
  const DB        = c.env.USERS_DB;
  const sessionId = (c.req.header('Authorization') || '').replace('Bearer ', '').trim();

  if (!sessionId) return c.json({ error: 'Not authenticated' }, 401);

  const session = await DB.prepare(
    `SELECT user_id, expires_at FROM sessions WHERE session_id = ?`
  ).bind(sessionId).first();

  if (!session) return c.json({ error: 'Session not found' }, 401);
  if (new Date(session.expires_at) < new Date()) {
    await DB.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sessionId).run().catch(() => {});
    return c.json({ error: 'Session expired' }, 401);
  }

  const user = await DB.prepare(
    `SELECT id, email, username, full_name, avatar_url, bio,
            role, plan, is_active, is_verified, verified_badge,
            link_count, follower_count, following_count,
            total_likes_received, created_at
     FROM   accounts WHERE id = ?`
  ).bind(session.user_id).first();

  if (!user) return c.json({ error: 'User not found' }, 404);

  return c.json({ ok: true, user });
});

export default router;
