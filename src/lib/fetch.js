// Fetch layer: plain HTTP first, with an optional headless-render fallback
// behind a lazy interface so the heavy dependency is only required when used.

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/**
 * Fetch a URL's HTML over plain HTTP.
 * @param {string} url
 * @param {{ timeoutMs?: number, userAgent?: string }} [opts]
 * @returns {Promise<{ html: string, status: number, finalUrl: string }>}
 */
export async function fetchHtml(url, opts = {}) {
  const { timeoutMs = 20000, userAgent = DEFAULT_UA } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();
    return { html, status: res.status, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render a URL with a headless browser (JS-executed DOM). Lazily imports
 * Playwright so it is only a hard requirement when `render: true` is used.
 * Throws a clear, actionable error if Playwright is not installed.
 * @param {string} url
 * @param {{ timeoutMs?: number, userAgent?: string }} [opts]
 * @returns {Promise<{ html: string, status: number, finalUrl: string }>}
 */
export async function renderHtml(url, opts = {}) {
  const { timeoutMs = 30000, userAgent = DEFAULT_UA } = opts;
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      `Source needs headless rendering (render: true) but "playwright" is not installed.\n` +
        `Install it with:  npm install playwright && npx playwright install chromium\n` +
        `Or set render:false for this source to use plain HTTP fetch instead.`,
    );
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent });
    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: timeoutMs,
    });
    const html = await page.content();
    return {
      html,
      status: response ? response.status() : 0,
      finalUrl: page.url(),
    };
  } finally {
    await browser.close();
  }
}

/**
 * Load a source's HTML, choosing plain fetch or headless render.
 * @param {{ url: string, render?: boolean, timeoutMs?: number }} source
 */
export async function loadSource(source) {
  const opts = { timeoutMs: source.timeoutMs };
  return source.render ? renderHtml(source.url, opts) : fetchHtml(source.url, opts);
}
