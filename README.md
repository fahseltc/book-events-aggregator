# book-events-aggregator

Crawl a configurable list of event sources (bookstore event pages, library RSS
feeds, etc.) and produce a single JSON list of **upcoming events** with date,
time, location, and description — ready to display however you like.

Zero runtime dependencies (Node 18+ built-ins only). Optional headless-browser
rendering uses Playwright, imported lazily only when a source needs it.

## Quick start

Requires Node 18+ (developed on Node 22).

```bash
# 1. Install dependencies (just Playwright, for JS-rendered sources).
npm install

# 2. Install the headless browser binary once (needed for render/provider sources).
npx playwright install chromium

# 3. Run the whole pipeline: crawl every source, then apply the keyword filter.
npm run pipeline

# 4. Browse the results in your browser.
npm run serve
#    then open http://127.0.0.1:8080/
```

That produces two files and opens a viewer over them:

- `output/events.json` — every upcoming event found, deduped.
- `output/events-filtered.json` — only events matching your keywords.

### Typical workflow

- **See all upcoming book events near you:** `npm run pipeline`, then
  `npm run serve` and use the **All events** tab.
- **Only the events you care about:** edit the keywords in
  `config/filters.json`, run `npm run filter` (no re-crawl needed), and use the
  **Filtered** tab. The filter reads the already-crawled data, so it's instant.
- **Add/remove a source:** edit `config/sources.json` (see
  [Configuring sources](#configuring-sources)), then `npm run crawl` again.
- **Add a one-off / annual event by hand:** edit `config/static-events.json`.
- **Use the data elsewhere:** the JSON files are plain and stable — load
  `output/events.json` into whatever you want (a site, a script, a calendar).

No command writes anywhere outside `output/` (and `.raw/` for `crawl:raw`), so
runs are safe to repeat.

## How it works

A generic, source-agnostic pipeline — no per-site code:

1. **Load** each configured source (plain HTTP `fetch`; optional headless render
   for JavaScript-rendered pages).
2. **Detect & extract**, in order of reliability:
   - **RSS/Atom feed** — if the response is a feed, parse `<item>`/`<entry>`
     elements directly. Preferred when available (structured + stable).
   - **JSON-LD** — parse `schema.org/Event` blocks embedded in the page. Exact.
   - **Heuristic** — segment the page into repeated "event cards" and parse
     dates/titles/locations from visible text. Fallback for plain HTML.
   - **Provider APIs** — some platforms expose a structured JSON API:
     - `bookmanager` (e.g. The Bookies) reads the BookManager API through a
       headless page session instead of scraping its calendar widget.
     - `tribe` reads the WordPress *The Events Calendar* REST API
       (`/wp-json/tribe/events/v1/events`) — cleaner than the plugin's RSS feed.
     - `eventbrite` discovers events from Eventbrite's public search page (see
       the Eventbrite note below).
3. **Two-stage crawl (HTML sources):** the configured URL is usually an *index*
   listing many events. Stage 1 discovers each event's detail-page link; stage 2
   visits those pages and extracts the richer per-event data (detail pages far
   more often carry JSON-LD). RSS sources skip this — feed items are already
   complete.
4. **Normalize** → ISO dates, filter to upcoming-only, sort by start time, and
   **dedupe**. Dedup runs in two passes: an exact pass (same normalized title on
   the same day) and a fuzzy pass that merges the *same* event listed by
   *different* sources — start times within a few hours and highly similar
   titles (token overlap, plus substring containment for cases like
   "Author Talk" vs "Author Talk Live at Tattered Cover"). The richer record
   (structured provider, more fields, specific event URL) is kept.
5. **Write** `output/events.json`.

## Usage

```bash
npm run crawl                     # crawl all enabled sources -> output/events.json (pretty)
npm run filter                    # keyword-filter -> output/events-filtered.json (pretty)
npm run pipeline                  # crawl then filter, in one step
npm run serve                     # local events viewer at http://127.0.0.1:8080/
npm run check                     # syntax-check every module
npm run crawl:raw                 # crawl + dump fetched index HTML to .raw/ (debug)
```

Direct CLI flags still work, e.g.:

```bash
node src/index.js --no-details    # skip stage 2 (faster, index data only)
node src/index.js --max-details 15
```

### Viewer

`npm run serve` starts a minimal loopback-only (127.0.0.1) static server and
opens a one-page viewer at <http://127.0.0.1:8080/>. It has two tabs —
**Filtered** (`output/events-filtered.json`) and **All events**
(`output/events.json`) — plus a client-side search box. Generate the data first
with `npm run pipeline`. The server only exposes `web/` and `output/`.

### Filtering by keyword

Produce a filtered view keeping only events whose text matches keywords from
`config/filters.json`. This reads the already-generated `output/events.json`, so
you can re-filter instantly without re-crawling.

```bash
node src/filter.js --pretty       # -> output/events-filtered.json
npm run filter                    # same via npm script
```

Edit `config/filters.json` to control it:

```json
{
  "keywords": ["author", "book club", "signing", "poetry", "storytime"],
  "fields": ["title", "description"],
  "caseSensitive": false,
  "wholeWord": false
}
```

| Field | Meaning |
|-------|---------|
| `keywords` (required) | An event is kept if **any** keyword appears in the scanned fields |
| `fields` | Which fields to scan: `title`, `description`, `location`, `source` (default: title + description) |
| `caseSensitive` | Match case-sensitively (default `false`) |
| `wholeWord` | Require whole-word matches, so `art` won't match `start` (default `false`) |

Each kept event is annotated with a `matchedKeywords` array (disable with
`--no-annotate`). Filter CLI options: `--in`, `--out`, `--config`, `--pretty`,
`--no-annotate`.

### Options

| Flag | Description |
|------|-------------|
| `--config <path>` | Sources config (default `config/sources.json`) |
| `--out <path>` | Output path (default `output/events.json`) |
| `--no-details` | Skip detail-page stage; use only index data |
| `--max-details <n>` | Cap detail-page visits per source (default 100) |
| `--concurrency <n>` | Parallel detail fetches (default 4) |
| `--delay <ms>` | Delay between detail fetches per worker (default 250) |
| `--include-past` | Keep past events (default: upcoming only) |
| `--pretty` | Pretty-print output JSON |

## Configuring sources

Edit `config/sources.json`. Add or remove entries in the `sources` array; set
`"enabled": false` to disable one without deleting it.

```json
{
  "sources": [
    { "name": "Denver Book Society", "url": "https://thedenverbooksociety.com/events" },
    { "name": "Douglas County Libraries", "url": "https://go.dcl.org/feeds?data=...", "type": "rss" },
    { "name": "Tattered Cover", "url": "https://.../event-calendar-page", "render": true },
    { "name": "Little Blue Pigeon Books", "url": "https://.../event-list", "render": true }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `url` (required) | Page or feed URL to crawl |
| `name` | Human-readable label (shown as `source` in output) |
| `type` | `auto` (default, detects RSS vs HTML), `rss`, `html`, `bookmanager`, `tribe`, `eventbrite`, or `static` |
| `search` | For `eventbrite`: `{ place, query, pages }` search parameters |
| `file` | For `static`: path to the hand-maintained events JSON |
| `render` | `true` to use a headless browser for JS-rendered pages |
| `enabled` | `false` to skip this source |
| `timeoutMs` | Per-source fetch timeout override |

Most sources work with just `url` (and a `name`) — `type` defaults to `auto`,
which detects RSS vs HTML and extracts whatever structured data it finds. Reach
for the other types only when a site needs it (see the notes below).

### Hand-maintained events (`static`)

Some events aren't on any crawlable index — annual festivals, conventions, or
sites that block bots. Add those by hand in `config/static-events.json`; they're
normalized, deduped, and filtered alongside crawled events. Each needs at least
a `title` and an ISO `start`:

```json
{
  "events": [
    {
      "title": "Fort Collins Book Fest",
      "start": "2027-04-09T10:00:00",
      "end": "2027-04-11T17:00:00",
      "location": "Fort Collins Senior Center, Fort Collins, CO",
      "url": "https://focobookfest.org/",
      "source": "FoCo Book Fest",
      "enabled": true
    }
  ]
}
```

Set `"enabled": false` to keep an entry without including it. Past-dated events
are dropped automatically, so update the dates each year as they're announced.

### JavaScript-rendered sources

Some sites (e.g. Shopify/Squarespace/Wix calendars) render events client-side,
so plain fetch returns little. Set `"render": true` on those sources. Playwright
is a dependency, but its browser binary must be installed once per machine:

```bash
npx playwright install chromium
```

Sources currently needing `render: true`: Tattered Cover, Little Blue Pigeon.
(The `bookmanager` and `eventbrite` provider sources drive the browser
themselves and don't use the `render` flag.)

### Eventbrite discovery

Eventbrite **retired their public event *search* API**, so there is no official
keyword/location search endpoint. The `eventbrite` source instead reads
Eventbrite's public search results page with the headless browser and parses the
`__SERVER_DATA__` JSON it embeds — no API key needed. Configure the search via
the source's `search` object:

```json
{
  "name": "Eventbrite (Denver books)",
  "url": "https://www.eventbrite.com/d/co--denver/books/",
  "type": "eventbrite",
  "search": { "place": "co--denver", "query": "books", "pages": 3 }
}
```

## Output shape

```jsonc
{
  "generatedAt": "2026-10-12T17:00:00.000Z",
  "count": 94,
  "sources": [ /* per-source crawl report */ ],
  "events": [
    {
      "title": "Mah Jongg Workshop Series",
      "description": "Learn to play mah jongg...",
      "start": "2026-10-14T17:00:00",
      "end": "2026-10-14T19:00:00",
      "location": "1700 N Humboldt St — 1700 North Humboldt Street, Denver, CO 80218",
      "url": "https://www.eventbrite.com/e/...",
      "source": "Denver Book Society",
      "extractor": "jsonld"
    }
  ]
}
```

## Project layout

```
config/sources.json         editable source list (+ sources.schema.json)
config/filters.json         keyword filter config (+ filters.schema.json)
src/index.js                CLI / orchestrator (two-stage crawl)
src/filter.js               CLI to produce a keyword-filtered events view
src/lib/filter.js           keyword matching logic
src/lib/fetch.js            HTTP fetch + lazy Playwright render
src/lib/html.js             dependency-free HTML helpers + card segmentation
src/lib/links.js            per-event detail-link discovery
src/lib/dates.js            freeform + RFC-822 date parsing
src/lib/normalize.js        normalize / dedupe / upcoming-filter / sort
src/lib/extract/index.js    per-page router: RSS > JSON-LD > heuristic
src/lib/extract/rss.js      RSS/Atom feed extractor
src/lib/extract/jsonld.js   schema.org/Event JSON-LD extractor
src/lib/extract/heuristic.js  visible-text card heuristic extractor
src/lib/extract/bookmanager.js  BookManager JSON-API provider (headless)
src/lib/extract/tribe.js    WordPress The Events Calendar REST provider
src/lib/extract/eventbrite.js  Eventbrite public-search discovery (headless)
src/lib/env.js              dependency-free .env loader
src/serve.js                loopback-only static server for the viewer
web/index.html              minimal two-tab events viewer (filtered / all)
.env.example                template for secrets (copy to .env, gitignored)
output/events.json          generated result (gitignored)
```

## Notes & limitations

- Image/flyer OCR and Instagram are intentionally out of scope for now; the
  extractor interface leaves room to add them as additional source types later.
- Heuristic extraction is conservative by design (prefers missing an event over
  inventing one), so some unusual page layouts may yield fewer events.
- Dates without an explicit year are assumed to be the nearest future
  occurrence.
```
