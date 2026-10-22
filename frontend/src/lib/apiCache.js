// In-tab LRU cache in front of the backend's /api/candles fetches. Kept
// deliberately simple:
//
//   1. Repeat lookups within the TTL return instantly (0 network calls).
//   2. Concurrent identical lookups share a single inflight promise (dedup).
//   3. Historical windows (`end` set) get a longer TTL — that data can't change.
//
// A small, validated snapshot of the latest chart window is also persisted so
// a refresh can paint recent bars before a slow source responds. It is only a
// provisional display: callers still fetch from the backend, and bad/expired
// snapshots are ignored rather than blocking fresh data.

const LIVE_TTL_MS = 60_000; // "latest" fetches — good for a minute
const PAST_TTL_MS = 24 * 60 * 60 * 1000; // fetches with explicit past `end` — historical
const MAX_ENTRIES = 120;
const SNAPSHOT_KEY = "tm:candleSnapshots:v1";
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_MAX_ENTRIES = 12;

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

function isCandle(value) {
  return value != null &&
    Number.isFinite(value.time) &&
    Number.isFinite(value.open) &&
    Number.isFinite(value.high) &&
    Number.isFinite(value.low) &&
    Number.isFinite(value.close) &&
    Number.isFinite(value.volume);
}

function readSnapshots() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readCandleSnapshot(key) {
  const now = Date.now();
  const entry = readSnapshots().find((item) =>
    item?.key === key &&
    Number.isFinite(item.savedAt) &&
    item.savedAt <= now &&
    now - item.savedAt <= SNAPSHOT_MAX_AGE_MS &&
    Array.isArray(item.candles) &&
    item.candles.length > 0 &&
    item.candles.length <= 500 &&
    item.candles.every(isCandle)
  );
  return entry ? entry.candles : null;
}

export function writeCandleSnapshot(key, candles) {
  if (!Array.isArray(candles) || !candles.length || candles.length > 500 || !candles.every(isCandle)) {
    return;
  }
  try {
    const snapshots = readSnapshots().filter((item) => item?.key !== key);
    snapshots.unshift({ key, savedAt: Date.now(), candles });
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots.slice(0, SNAPSHOT_MAX_ENTRIES)));
  } catch {
    // Browser storage is an optional optimization; network loading remains authoritative.
  }
}

// Wipe blobs from the earlier, unvalidated persisted-cache implementation.
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
export async function cachedFetch(key, hasEnd, loader) {
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
