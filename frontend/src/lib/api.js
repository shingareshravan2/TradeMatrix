export async function fetchSources() {
  const res = await fetch("/api/sources");
  if (!res.ok) throw new Error("failed to load sources");
  return res.json();
}

import { cachedFetch } from "./apiCache";

export async function fetchCandles(source, symbol, interval, limit = 500, end, onFresh) {
  const params = new URLSearchParams({ source, symbol, interval, limit });
  if (end != null) params.set("end", end);
  const key = params.toString();
  return cachedFetch(key, end != null, async () => {
    const res = await fetch(`/api/candles?${params}`);
    if (!res.ok) {
      const body = await res.text();
      let detail = body;
      try {
        detail = JSON.parse(body).detail || body;
      } catch {}
      throw new Error(`failed to load candles: ${res.status}${detail ? ` - ${detail}` : ""}`);
    }
    return res.json();
  }, onFresh);
}

// Omit `source` to search across all sources at once.
export async function searchSymbols(query, source) {
  const params = new URLSearchParams({ query });
  if (source) params.set("source", source);
  const res = await fetch(`/api/search?${params}`);
  if (!res.ok) throw new Error("search failed");
  return res.json();
}
