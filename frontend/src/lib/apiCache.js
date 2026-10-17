// In-tab LRU cache in front of the backend's /api/candles fetches. Kept
// deliberately simple:
//
//   1. Repeat lookups within the TTL return instantly (0 network calls).
//   2. Concurrent identical lookups share a single inflight promise (dedup).
//   3. Historical windows (`end` set) get a longer TTL — that data can't change.
//
// The earlier version persisted results to localStorage to survive refreshes.
// That layer proved fragile: any transient backend error, malformed response,
// or partial write left a stuck blob that hydrated on next load and blocked
// fresh fetches from painting. Ripped out — every fresh page load now goes to
// the network cleanly. The tradeoff is a small delay on refresh (Databento
// cold ~6s, Hyperliquid <1s), which is preferable to "chart not loading" from
// stale cache.

const LIVE_TTL_MS = 60_000; // "latest" fetches — good for a minute
const PAST_TTL_MS = 24 * 60 * 60 * 1000; // fetches with explicit past `end` — historical
const MAX_ENTRIES = 120;

const store = new Map(); // key -> { promise, expiresAt }

function ttlFor(hasEnd) {
  return hasEnd ? PAST_TTL_MS : LIVE_TTL_MS;
}

function evictIfNeeded() {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// Wipe any leftover persisted-cache blobs from earlier versions of this
// module so they don't take up localStorage space or confuse the user.
try {
  localStorage.removeItem("tm:apiCache:v1");
  localStorage.removeItem("tm:apiCache:v2");
} catch {}

/**
 * `loader()` MUST return a fresh network promise. `key` uniquely identifies the
 * request shape. `hasEnd` picks the TTL policy.
 *
 * `onRevalidate` is accepted for backwards compatibility with callers that pass
 * it (useCandleStream). It's a no-op in this simplified cache — kept so the
 * signature stays stable and callers don't have to change.
 *
 * On error the entry is dropped so a retry actually hits the network again
 * instead of caching the failure.
 */
export async function cachedFetch(key, hasEnd, loader, _onRevalidate) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    store.delete(key);
    store.set(key, hit);
    return hit.promise;
  }

  const promise = loader();
  const entry = { promise, expiresAt: now + ttlFor(hasEnd) };
  store.set(key, entry);
  evictIfNeeded();

  try {
    const result = await promise;
    if (Array.isArray(result) && result.length === 0 && store.get(key) === entry) {
      store.delete(key);
    }
    return result;
  } catch (err) {
    if (store.get(key) === entry) store.delete(key);
    throw err;
  }
}

export function clearApiCache() {
  store.clear();
}
