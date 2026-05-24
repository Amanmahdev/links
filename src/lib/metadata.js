// Fetches a URL and extracts Open Graph / standard meta tags
// Called by the upload tool when the user wants auto-filled title/description/thumbnail

export async function fetchMetadata(url) {
  const result = {
    title:        '',
    description:  '',
    thumbnail:    '',
    domain:       '',
  };

  try {
    result.domain = new URL(url).hostname.replace(/^www\./, '');

    const res = await fetch(url, {
      redirect:  'follow',
      headers: {
        'User-Agent': 'Enwekbot/1.0 (+https://enwek.com)',
        'Accept':     'text/html',
      },
      // Workers have a 30-second CPU limit; abort early on slow sites
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return result;

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return result;

    // Read only the first 50 KB — enough to capture <head>
    const reader  = res.body.getReader();
    const chunks  = [];
    let   total   = 0;
    const MAX     = 50_000;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= MAX) { reader.cancel(); break; }
    }

    const html = new TextDecoder().decode(
      chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array(0))
    );

    // ── title ──────────────────────────────────────────────────
    result.title =
      _og(html, 'og:title')            ||
      _og(html, 'twitter:title')       ||
      _tag(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
      '';

    // ── description ────────────────────────────────────────────
    result.description =
      _og(html, 'og:description')       ||
      _og(html, 'twitter:description')  ||
      _meta(html, 'description')        ||
      '';

    // ── thumbnail ──────────────────────────────────────────────
    result.thumbnail =
      _og(html, 'og:image')             ||
      _og(html, 'twitter:image')        ||
      '';

    // Clean up
    result.title       = _clean(result.title).slice(0, 300);
    result.description = _clean(result.description).slice(0, 1000);

  } catch (err) {
    // Network errors, timeouts, CORS — return what we have
    console.warn('fetchMetadata error:', err?.message);
  }

  return result;
}

// ── helpers ────────────────────────────────────────────────────

function _og(html, prop) {
  const re = new RegExp(
    `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'
  );
  const m = html.match(re) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'));
  return m ? m[1] : '';
}

function _meta(html, name) {
  const re = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'
  );
  const m = html.match(re) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'));
  return m ? m[1] : '';
}

function _tag(html, re) {
  const m = html.match(re);
  return m ? m[1] : '';
}

function _clean(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
