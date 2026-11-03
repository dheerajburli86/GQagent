"use strict";
// Keyless public data, from fixed hosts (the model never chooses a URL here):
//   fx       European Central Bank reference rates via Frankfurter (daily, ~16:00 CET), incl. history
//   crypto   CoinGecko public prices (USD/INR + 24h change)
//   weather  Open-Meteo current conditions + 3-day forecast for a named place
const { clamp } = require("./util");

const UA = "Mozilla/5.0 (compatible; GQuantsAgent/1.0)";
async function getJson(f, url) {
  const r = await f(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const CCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function fx(a, f) {
  const base = String(a.base || "USD").toUpperCase();
  const to = String(a.symbols || "INR").toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 12);
  if (!CCY.test(base) || !to.every((c) => CCY.test(c))) return { error: "use 3-letter currency codes, e.g. base USD, symbols INR,EUR" };
  if (a.date && !DATE.test(a.date)) return { error: "date must be YYYY-MM-DD" };
  const path = a.date ? a.date : "latest";
  const q = `from=${base}&to=${to.filter((c) => c !== base).join(",")}`;
  let j;
  try { j = await getJson(f, `https://api.frankfurter.dev/v1/${path}?${q}`); }
  catch { j = await getJson(f, `https://api.frankfurter.app/${path}?${q}`); }
  return { source: "European Central Bank reference rates (Frankfurter)", base: j.base, date: j.date, rates: j.rates,
    note: "ECB reference rates are set once per working day around 16:00 CET; they are not live market quotes. Currencies the ECB does not publish are missing." };
}

async function crypto(a, f) {
  const wanted = String(a.symbols || "bitcoin").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const ids = [];
  for (const w of wanted) {
    if (/^[a-z0-9-]+$/.test(w) && w.length > 4) { ids.push(w.toLowerCase()); continue; }
    const s = await getJson(f, `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(w)}`);
    const hit = (s.coins || []).find((c) => c.symbol && c.symbol.toLowerCase() === w.toLowerCase()) || (s.coins || [])[0];
    if (hit) ids.push(hit.id);
  }
  if (!ids.length) return { error: "no matching coins" };
  const j = await getJson(f, `https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(ids)].join(",")}&vs_currencies=usd,inr&include_24hr_change=true&include_market_cap=true&include_last_updated_at=true`);
  const out = Object.entries(j).map(([id, v]) => ({
    id, usd: v.usd, inr: v.inr, change_24h_pct: v.usd_24h_change != null ? Number(v.usd_24h_change.toFixed(2)) : null,
    market_cap_usd: v.usd_market_cap, updated: v.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : null,
  }));
  return { source: "CoinGecko", prices: out, note: "Prices only; no buy/sell view." };
}

const WMO = { 0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "violent rain showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail" };

async function weather(a, f) {
  const place = String(a.place || "").trim().slice(0, 80);
  if (!place) return { error: "place is required, e.g. Mumbai" };
  const g = await getJson(f, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
  const loc = (g.results || [])[0];
  if (!loc) return { error: `could not find a place called "${place}"` };
  const days = clamp(a.days, 1, 7, 3);
  const j = await getJson(f, `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code&timezone=auto&forecast_days=${days}`);
  const c = j.current || {}, d = j.daily || {};
  return {
    source: "Open-Meteo", place: [loc.name, loc.admin1, loc.country].filter(Boolean).join(", "), timezone: j.timezone,
    current: { time: c.time, temp_c: c.temperature_2m, feels_like_c: c.apparent_temperature, humidity_pct: c.relative_humidity_2m, precipitation_mm: c.precipitation, wind_kmh: c.wind_speed_10m, conditions: WMO[c.weather_code] || `code ${c.weather_code}` },
    daily: (d.time || []).map((t, i) => ({ date: t, min_c: d.temperature_2m_min[i], max_c: d.temperature_2m_max[i], rain_mm: d.precipitation_sum[i], rain_chance_pct: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null, conditions: WMO[d.weather_code[i]] || `code ${d.weather_code[i]}` })),
  };
}

const tool = {
  name: "public_data",
  description: "Live public data without a key. kind='fx': currency exchange rates (ECB reference, daily; optional historical date). kind='crypto': cryptocurrency prices in USD and INR with 24h change. kind='weather': current weather and a short forecast for a place. For stock/ETF/index data use the heatmap-dashboard live tools instead.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["fx", "crypto", "weather"] },
      base: { type: "string", description: "fx: base currency, default USD" },
      symbols: { type: "string", description: "fx: target currencies, comma-separated (default INR). crypto: coins by name, id or ticker, comma-separated (e.g. bitcoin,ETH,solana)" },
      date: { type: "string", description: "fx: YYYY-MM-DD for a historical rate (optional)" },
      place: { type: "string", description: "weather: city or place name" },
      days: { type: "integer", description: "weather: forecast days 1-7, default 3" },
    },
    required: ["kind"],
  },
  async run(a, ctx) {
    const f = ctx.fetch || fetch;
    if (a.kind === "fx") return fx(a, f);
    if (a.kind === "crypto") return crypto(a, f);
    if (a.kind === "weather") return weather(a, f);
    return { error: "kind must be fx, crypto or weather" };
  },
};

module.exports = { tool };
