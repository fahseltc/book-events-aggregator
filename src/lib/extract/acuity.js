// Squarespace Scheduling / Acuity provider (e.g. Spell Books).
//
// Acuity booking pages are a React SPA, but the data is reachable over plain
// HTTP without a browser:
//   1. GET schedule.php?owner=<ownerNum> -> sets a PHPSESSID cookie.
//   2. GET /schedule/<slug>/ -> the shell HTML embeds (a) a session UUID and
//      (b) the appointment types (classes) as {id,name} objects.
//   3. GET /api/scheduling/v1/availability/times?owner=<slug>&appointmentTypeId=<id>
//        &calendarId=<cal>&startDate=<d>&maxDays=N&timezone=<tz>
//      with headers X-Secondo-Session, X-Secondo-Owner and the cookie ->
//      { "YYYY-MM-DD": [ { time: ISO, slotsAvailable } ] }.
//
// We emit one event per (class, scheduled date). Appointment types that are
// clearly booking intake (readings, forms, generic appointments) are skipped
// via a keyword guard; the downstream keyword filter catches the rest.

const BASE = 'https://app.acuityscheduling.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Appointment-type names that aren't public "events" (1:1 bookings / intake forms).
const SKIP_NAME = /\b(reading|birth chart|registration form|intake|consultation|\bform\b)\b/i;

/**
 * @param {object} source  needs source.acuity = { owner, slug, calendarId, timezone?, months? }
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromAcuity(source, ctx = {}) {
  const cfg = source.acuity || {};
  const owner = String(cfg.owner || '');
  const slug = String(cfg.slug || '');
  const calendarId = String(cfg.calendarId || '');
  const timezone = cfg.timezone || 'America/Denver';
  const maxDays = Math.max(1, Math.min(365, (cfg.months || 4) * 31));
  if (!owner || !slug) {
    throw new Error('Acuity source needs acuity.owner and acuity.slug in the config.');
  }
  const now = ctx.now || new Date();

  // 1. Session cookie.
  let cookie = '';
  const r1 = await fetchWithTimeout(
    `${BASE}/schedule.php?owner=${encodeURIComponent(owner)}&ref=sched_block`,
    { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'manual' },
    ctx.timeoutMs,
  );
  cookie = firstCookie(r1) || cookie;

  // 2. Shell HTML -> session UUID + appointment types.
  const r2 = await fetchWithTimeout(
    `${BASE}/schedule/${slug}/?isInConfig=false&ref=sched_block`,
    { headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: cookie }, redirect: 'follow' },
    ctx.timeoutMs,
  );
  cookie = firstCookie(r2) || cookie;
  const html = await r2.text();
  const session = (html.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0] || '';
  const types = parseAppointmentTypes(html).filter((t) => !SKIP_NAME.test(t.name));

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'X-Secondo-Session': session,
    'X-Secondo-Owner': slug,
    Cookie: cookie,
  };
  const startDate = now.toISOString().slice(0, 10);

  const out = [];
  for (const t of types) {
    const url =
      `${BASE}/api/scheduling/v1/availability/times?owner=${encodeURIComponent(slug)}` +
      `&appointmentTypeId=${encodeURIComponent(t.id)}&calendarId=${encodeURIComponent(calendarId)}` +
      `&startDate=${startDate}&maxDays=${maxDays}&timezone=${encodeURIComponent(timezone)}`;
    let json;
    try {
      const res = await fetchWithTimeout(url, { headers }, ctx.timeoutMs);
      if (!res.ok) continue;
      json = JSON.parse(await res.text());
    } catch {
      continue; // one class failing shouldn't drop the rest
    }
    // Response shape: { "YYYY-MM-DD": [ { time, slotsAvailable } ] }
    const slots = [];
    for (const day of Object.keys(json || {})) {
      for (const s of json[day] || []) if (s && s.time) slots.push(s.time);
    }
    // One event per distinct scheduled datetime.
    for (const iso of [...new Set(slots)]) {
      out.push({
        title: t.name,
        description: undefined,
        start: toLocalIso(iso),
        end: undefined,
        location: source.locationName || undefined,
        url: `${BASE}/schedule/${slug}/?appointmentType=${t.id}`,
        sourceName: source.name,
        sourceUrl: source.url,
        extractor: 'acuity',
      });
    }
  }
  return out;
}

// Pull {id,name} appointment types out of the shell HTML's embedded config.
function parseAppointmentTypes(html) {
  const found = new Map();
  const re = /\{[^{}]*?"id"\s*:\s*(\d+)[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?\}/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const name = decode(m[2]);
    if (!found.has(id)) found.set(id, { id, name });
  }
  return [...found.values()];
}

// Acuity returns ISO with an offset (e.g. "2026-10-26T22:00:00-0600"). Keep the
// local wall-clock (strip the offset) to match the rest of the pipeline.
function toLocalIso(iso) {
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : iso;
}

function firstCookie(res) {
  const sc = res.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : '';
}

function decode(s) {
  return String(s)
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(timeoutMs ?? 0, 20000));
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
