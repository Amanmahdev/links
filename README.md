# enwek-worker

Cloudflare Worker (Hono + D1) that handles the **links insertion** and **random fetch** pipeline for Enwek.

---

## Project structure

```
enwek-worker/
├── src/
│   └── index.ts          ← Hono worker — all API routes
├── public/
│   ├── upload.html       ← Admin panel: single & bulk link upload
│   └── fetch.html        ← Discovery page: random links with filters
├── wrangler.toml
├── package.json
└── tsconfig.json
```

---

## Quick start

### 1 — Install dependencies
```bash
npm install
```

### 2 — Create the D1 database
```bash
npx wrangler d1 create enwek-db
# Copy the database_id printed to stdout
```

Paste the `database_id` into `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "enwek-db"
database_id = "PASTE_ID_HERE"
```

### 3 — Apply the schema
```bash
npx wrangler d1 execute enwek-db --file=../enwek_schema.sql
```

### 4 — Set secrets
In `wrangler.toml` set your `ADMIN_SECRET` (used to protect `/api/links/bulk`).  
For production, use Wrangler secrets instead:
```bash
npx wrangler secret put ADMIN_SECRET
```

### 5 — Dev server
```bash
npm run dev
# → http://localhost:8787
```
Then open:
- `http://localhost:8787/upload.html` — upload panel
- `http://localhost:8787/fetch.html`  — discovery page

### 6 — Deploy
```bash
npm run deploy
```

---

## API reference

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/metadata?url=<url>` | — | Scrape OG/meta tags from a URL |
| `GET` | `/api/categories` | — | List all categories |
| `POST` | `/api/links` | — | Insert a single link |
| `POST` | `/api/links/bulk` | `X-Admin-Secret` header | Insert up to 500 links |
| `GET` | `/api/links/random` | — | Fetch N random active links |
| `GET` | `/api/links/random?category=slug` | — | Random within a category |
| `GET` | `/api/links/random?format=video` | — | Random by format |
| `GET` | `/api/links/:id` | — | Get a link by ID |

### POST /api/links — body
```json
{
  "url": "https://example.com/article",
  "category_id": "cat_tech",
  "title": "optional — auto-fetched if blank",
  "description": "optional",
  "thumbnail": "optional",
  "submitted_by": "user_nanoid (optional)"
}
```

### POST /api/links/bulk — body
```json
{
  "links": [
    { "url": "https://..." },
    { "url": "https://...", "category_id": "cat_sci" }
  ]
}
```
Header: `X-Admin-Secret: <your secret>`

### GET /api/links/random — query params
| param | default | description |
|-------|---------|-------------|
| `count` | `1` | Number of links (max 50) |
| `category` | — | Category slug (e.g. `tech`) |
| `format` | — | `page` \| `video` \| `pdf` \| `software` |

---

## upload.html

- **Single mode** — paste one URL, see a live metadata preview, pick a category, click Insert.
- **Bulk mode** — paste up to 500 URLs (one per line), pick a category, click Upload.  
  Metadata is fetched automatically per URL.  
  Requires the Admin Secret.
- Session stats panel shows inserted / duplicate / error counts.
- Live log panel with per-URL status.

## fetch.html

- Loads a random batch of links from the DB on page open.
- **Category filter pills** (loaded from `/api/categories`).
- **Format filter tabs** (All / Pages / Videos / PDFs / Software).
- Count selector: 6 / 12 / 24 / 48 links.
- **Shuffle** button (or press `Space`) to reshuffle.
- Cards show thumbnail, title, description, domain, category, format badge, like/comment counts.
