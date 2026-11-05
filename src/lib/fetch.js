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
  // Give JS-heavy pages room; never shorter than 45s even if a caller passes a
  // small HTTP-oriented timeout.
  const { userAgent = DEFAULT_UA, settleMs = 1500 } = opts;
  const timeoutMs = Math.max(opts.timeoutMs ?? 0, 45000);
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
    // Use 'domcontentloaded', NOT 'networkidle': many site builders (Wix,
    // Squarespace) keep background requests going forever, so 'networkidle'
    // never settles and times out even though the content has loaded. We then
    // pause briefly to let client-rendered content populate.
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    await page.waitForTimeout(settleMs);
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
 * Render several URLs, yielding each page as it loads. All pages share one
 * browser, but each URL gets its own fresh context. Reusing one page for later
 * navigations left Cloudflare's challenge stuck on "Just a moment...". Stop early
 * by breaking out of the loop; the browser closes either way.
 * @param {string[]} urls
 * @param {{ timeoutMs?: number, userAgent?: string, settleMs?: number, challengeWaitMs?: number }} [opts]
 * @yields {{ url: string, html: string, status: number, finalUrl: string }}
 */
export async function* renderPages(urls, opts = {}) {
  const { userAgent = DEFAULT_UA, settleMs = 1500, challengeWaitMs = 30000 } = opts;
  const timeoutMs = Math.max(opts.timeoutMs ?? 0, 45000);
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      `Source needs headless rendering but "playwright" is not installed.\n` +
      `Install it with:  npm install playwright && npx playwright install chromium`,
    );
  }
  const browser = await chromium.launch();
  try {
    for (const url of urls) {
      const context = await browser.newContext({ userAgent });
      try {
        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        // Cloudflare shows "Just a moment..." first, then replaces it. Wait for the
        // title to change; if it never does, the caller sees the challenge page.
        await page
          .waitForFunction(() => !/Just a moment/i.test(document.title), null, { timeout: challengeWaitMs })
          .catch(() => { });
        await page.waitForTimeout(settleMs);
        yield {
          url,
          html: await page.content(),
          status: response ? response.status() : 0,
          finalUrl: page.url(),
        };
      } finally {
        await context.close();
      }
    }
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
