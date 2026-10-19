// Shared type definitions (JSDoc only; no runtime code).

/**
 * A raw event as emitted by an extractor, before normalization.
 * @typedef {Object} RawEvent
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [start]       raw or ISO start date/time
 * @property {string} [end]         raw or ISO end date/time
 * @property {string} [location]
 * @property {string} [url]
 * @property {string} [sourceName]
 * @property {string} [sourceUrl]
 * @property {('jsonld'|'heuristic')} extractor
 */

/**
 * A normalized, output-ready event.
 * @typedef {Object} Event
 * @property {string} title
 * @property {string|null} description
 * @property {string} start         ISO 8601
 * @property {string|null} end      ISO 8601 or null
 * @property {string|null} location
 * @property {string} url
 * @property {string} source        human-readable source name
 * @property {string} extractor
 * @property {string} [firstSeen]   ISO stamp of the run this event first appeared in
 */

export { };
