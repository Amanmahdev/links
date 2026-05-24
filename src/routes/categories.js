import { Hono } from 'hono';

const router = new Hono();

// GET /api/categories
// Returns all categories ordered by display_order.
// Used by both fetch.html and upload.html to populate filters / dropdowns.
router.get('/', async (c) => {
  const DB = c.env.LINKS_DB;
  try {
    const { results } = await DB.prepare(`
      SELECT id, name, slug, parent_id, link_count, display_order
      FROM   categories
      ORDER  BY display_order ASC, name ASC
    `).all();

    return c.json(results);
  } catch (err) {
    console.error('categories GET:', err);
    return c.json({ error: 'Failed to load categories' }, 500);
  }
});

export default router;
