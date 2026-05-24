# Enwek Worker — links.enwek.com

Cloudflare Worker powering the Enwek link platform.
Built with **Hono** + **Cloudflare D1 (SQLite)**.

---

## Project structure

```
enwek-worker/
├── src/
│   ├── index.js              ← entry point, CORS, all routes mounted
│   ├── routes/
│   │   ├── links.js          ← GET random, GET feed, POST single, POST bulk
│   │   ├── categories.js     ← GET /api/categories
│   │   ├── metadata.js       ← GET /api/metadata?url=…
│   │   ├── comments.js       ← GET + POST /api/comments/:linkId
│   │   ├── auth.js           ← register, login, logout, me
│   │   └── scores.js         ← POST /api/internal/refresh-scores
│   └── lib/
│       ├── nanoid.js         ← ID generator (Web Crypto, no Node)
│       ├── hash.js           ← SHA-256 URL hash, domain extractor, hot score
│       └── metadata.js       ← OG/meta tag scraper
├── schema.sql                ← full D1 schema (apply once per database)
├── wrangler.toml             ← Cloudflare config
└── package.json
```

---

## First-time setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create both D1 databases
```bash
wrangler d1 create enwek-users
wrangler d1 create enwek-links
```

Copy the `database_id` values printed by each command into `wrangler.toml`:
```toml
[[d1_databases]]
binding       = "USERS_DB"
database_name = "enwek-users"
database_id   = "PASTE_USERS_ID_HERE"

[[d1_databases]]
binding       = "LINKS_DB"
database_name = "enwek-links"
database_id   = "PASTE_LINKS_ID_HERE"
```

### 3. Apply the schema

The schema file covers both logical databases (users tables and links tables
are all in `schema.sql`). Apply it to **both** databases — D1 uses
`IF NOT EXISTS` so tables that don't apply to a DB simply won't be created
(they'll error silently and skip). Alternatively keep two separate schema
files for strict separation.

```bash
# Apply to users DB (creates accounts, sessions, subscriptions, follows, notifications, password_resets)
wrangler d1 execute enwek-users --file=schema.sql

# Apply to links DB (creates links, categories, likes, saves, clicks, comments, comment_likes, reports, tags)
wrangler d1 execute enwek-links --file=schema.sql
```

### 4. Set the admin secret
```bash
wrangler secret put ADMIN_SECRET
# Type a strong random string when prompted
# This is required for /api/links/bulk and /api/internal/refresh-scores
```

### 5. Run locally
```bash
npm run dev
# Worker available at http://localhost:8787
```

### 6. Deploy
```bash
npm run deploy
# Deploys to links.enwek.com (set up a Custom Domain in the CF dashboard)
```

---

## API reference

All endpoints are at `https://links.enwek.com`.

### fetch.html endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/categories` | All categories (for filter pills) |
| `GET` | `/api/links/random?count=12&category=tech&format=video` | Random link batch |

### upload.html endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/categories` | Categories for dropdown |
| `GET` | `/api/metadata?url=https://…` | Auto-fetch OG title/description/thumbnail |
| `POST` | `/api/links` | Insert single link |
| `POST` | `/api/links/bulk` | Insert up to 100 links (requires `X-Admin-Secret`) |

### Other endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/links?sort=hot&page=1` | Paginated feed |
| `GET` | `/api/links/:id` | Single link |
| `POST` | `/api/links/:id/click` | Record click |
| `POST` | `/api/links/:id/like` | Toggle like |
| `POST` | `/api/links/:id/save` | Toggle save |
| `GET` | `/api/comments/:linkId` | Link comments |
| `POST` | `/api/comments/:linkId` | Post comment |
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Log in |
| `POST` | `/api/auth/logout` | Log out |
| `GET` | `/api/auth/me` | Current user (Bearer token) |
| `POST` | `/api/internal/refresh-scores` | Recalculate hot scores (X-Internal-Secret) |
| `GET` | `/health` | Uptime check |

### Single link insert body
```json
{
  "url":         "https://example.com/article",
  "category_id": "cat_tech",
  "title":       "Optional — auto-fetched if empty",
  "description": "Optional",
  "thumbnail":   "Optional image URL",
  "format":      "page"
}
```

### Bulk insert body
```json
{
  "links": [
    { "url": "https://example.com/1", "category_id": "cat_tech" },
    { "url": "https://example.com/2", "category_id": "cat_sci"  }
  ]
}
```
Header required: `X-Admin-Secret: your-secret`

---

## Enabling the hourly cron (hot score refresh)

Add to `wrangler.toml`:
```toml
[triggers]
crons = ["0 * * * *"]
```

The `scheduled` handler in `src/index.js` runs automatically every hour,
recalculating hot scores only for links active in the last 24 hours.

---

## CORS

The worker allows requests from:
- `https://enwek.com`
- Any `*.enwek.com` subdomain
- `http://localhost:*` and `http://127.0.0.1:*` (dev)
- The value of `ALLOWED_ORIGIN` in `wrangler.toml`

Update `ALLOWED_ORIGIN` for staging environments.
