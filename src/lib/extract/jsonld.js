// Extract events from schema.org/Event JSON-LD blocks. When present this is
// the most reliable, exact source of event data and needs no guessing.

import { extractJsonLdBlocks } from '../html.js';

/**
 * @param {string} html
 * @param {{ sourceName?: string, sourceUrl?: string }} ctx
 * @returns {import('../types.js').RawEvent[]}
 */
export function extractFromJsonLd(html, ctx = {}) {
  const events = [];
  for (const raw of extractJsonLdBlocks(html)) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue; // malformed block; skip
    }
    for (const node of flatten(data)) {
      if (isEventNode(node)) events.push(toRawEvent(node, ctx));
    }
  }
  return events;
}

// JSON-LD can be a single object, an array, or wrapped in @graph.
function flatten(data, out = []) {
  if (Array.isArray(data)) {
    for (const item of data) flatten(item, out);
  } else if (data && typeof data === 'object') {
    out.push(data);
    if (Array.isArray(data['@graph'])) flatten(data['@graph'], out);
  }
  return out;
}

function isEventNode(node) {
  const type = node && node['@type'];
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && /event$/i.test(t));
}

function toRawEvent(node, ctx) {
  return {
    title: str(node.name),
    description: str(node.description),
    start: str(node.startDate),
    end: str(node.endDate),
    location: locationToText(node.location),
    url: str(node.url) || ctx.sourceUrl,
    sourceName: ctx.sourceName,
    sourceUrl: ctx.sourceUrl,
    extractor: 'jsonld',
  };
}

function locationToText(loc) {
  if (!loc) return undefined;
  if (typeof loc === 'string') return loc;
  const nodes = Array.isArray(loc) ? loc : [loc];
  const results = [];

  for (const l of nodes) {
    if (typeof l === 'string') {
      results.push(l.trim());
      continue;
    }
    const name = str(l.name);
    const addr = addressToText(l.address);
    // Avoid duplicating when the venue "name" is really just the street
    // address (common in Eventbrite feeds) or is already inside the address.
    let combined;
    if (name && addr) {
      combined = addr.includes(name) || name.includes(addr) ? longer(name, addr) : `${name} — ${addr}`;
    } else {
      combined = name || addr;
    }
    if (combined) results.push(combined);
  }

  const joined = dedupeParts(results).join(' — ').trim();
  return joined || undefined;
}

// Build an address string without repeating a locality/region already present
// in the (sometimes over-stuffed) streetAddress field.
function addressToText(addr) {
  if (!addr) return undefined;
  if (typeof addr === 'string') return addr.trim() || undefined;
  if (typeof addr !== 'object') return undefined;
  const street = str(addr.streetAddress) || '';
  const parts = [street];
  for (const extra of [addr.addressLocality, addr.addressRegion, addr.postalCode]) {
    const v = str(extra);
    if (v && !street.toLowerCase().includes(v.toLowerCase())) parts.push(v);
  }
  return dedupeParts(parts).join(', ').trim() || undefined;
}

function dedupeParts(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const v = (p || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function longer(a, b) {
  return a.length >= b.length ? a : b;
}

function str(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  return String(v);
}
