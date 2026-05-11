import { Hono } from 'hono';

const app = new Hono();

// Serve HTML
app.get('/', async (c) => {
	const html = await fetch('https://enwek.com/post/insrtli.html').then(r => r.text());
	return c.html(html);
});

// Get metadata
app.get('/metadata', async (c) => {

	const url = c.req.query('url');

	if (!url) {
		return c.json({ error: 'Missing URL' }, 400);
	}

	try {

		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0'
			}
		});

		const html = await response.text();

		const getMeta = (name) => {

			const regex = new RegExp(
				'<meta[^>]+(?:property|name)=["\\\']' +
				name +
				'["\\\'][^>]+content=["\\\']([^"\\\']+)["\\\']',
				'i'
			);

			const match = html.match(regex);

			return match ? match[1] : '';
		};

		const titleMatch = html.match(/<title>(.*?)<\\/title>/i);

		const parsed = new URL(url);

		return c.json({
			title:
				getMeta('og:title') ||
				(titleMatch ? titleMatch[1] : ''),

			description:
				getMeta('og:description') ||
				getMeta('description') ||
				'',

			thumbnail:
				getMeta('og:image') ||
				'',

			domain:
				parsed.hostname
		});

	} catch (err) {

		return c.json({
			error: 'Failed to fetch metadata'
		}, 500);

	}

});

// Insert into DB
app.post('/submit', async (c) => {

	const body = await c.req.json();

	try {

		await c.env.EL.prepare(`
			INSERT INTO biglinks
			(
				link,
				category,
				title,
				description,
				thumbnail,
				domain
			)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
		.bind(
			body.link,
			body.category,
			body.title,
			body.description,
			body.thumbnail,
			body.domain
		)
		.run();

		return c.json({
			success: true
		});

	} catch (err) {

		return c.json({
			error: 'Database insert failed'
		}, 500);

	}

});

export default app;
