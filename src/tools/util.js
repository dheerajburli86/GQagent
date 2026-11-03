"use strict";
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
// Search text goes into ilike patterns: keep letters, digits and a few symbols only.
const cleanText = (s, max = 60) => String(s || "").replace(/[^\p{L}\p{N} .&\-'^:/]/gu, "").trim().slice(0, max);
const pick = (o, keys) => { const r = {}; if (!o) return r; for (const k of keys) if (o[k] !== undefined && o[k] !== null) r[k] = o[k]; return r; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round = (v, d = 2) => (typeof v === "number" ? Math.round(v * 10 ** d) / 10 ** d : v);
module.exports = { clamp, num, cleanText, pick, UUID, round };
