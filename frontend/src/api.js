// frontend/src/api.js

// Resolve API base once (supports VITE_API_BASE or VITE_API_BASE_URL)
const RAW_BASE =
  import.meta.env.VITE_API_BASE ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://127.0.0.1:8000";

// Normalize: no trailing slash
export const API_BASE = String(RAW_BASE).replace(/\/+$/, "");

// -------- fetch helpers --------
const DEFAULT_RETRIES = 1; // network/5xx retry attempts (in addition to the first try)
const RETRY_DELAY_MS = 350;

const defaultGetHeaders = {
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Accept: "application/json",
};

const defaultPostHeaders = {
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Content-Type": "application/json",
  Accept: "application/json",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildURL(path, params) {
  const url = new URL(`${API_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  // query params
  if (params && typeof params === "object") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  // cache-buster to avoid stale edge caches
  url.searchParams.set("_ts", Date.now().toString());
  return url;
}

// Wrap fetch with small retry on network/5xx/429
async function fetchWithRetry(url, options = {}, retries = DEFAULT_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      // Retry on 429/5xx
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr;
}

// Consistent JSON handling + better error messages
async function handle(res) {
  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.detail || err?.message;
    } catch {
      try {
        const text = await res.text();
        detail = text?.slice?.(0, 300);
      } catch {
        /* ignore */
      }
    }
    const msg = detail ? `${res.status} ${res.statusText} – ${detail}` : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  // parse JSON (tolerate empty body)
  const txt = await res.text();
  return txt ? JSON.parse(txt) : {};
}

// -------- API functions --------

export async function fetchHello() {
  const url = buildURL("/hello");
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

export async function fetchPredict({ ticker, models }) {
  const url = buildURL("/predict");
  return handle(
    await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: defaultPostHeaders,
        body: JSON.stringify({ ticker, models }),
        cache: "no-store",
      },
      DEFAULT_RETRIES
    )
  );
}

/**
 * Retrospective “next-day” history for the last N trading days.
 * Returns: { ticker, models, rows: [{ date, close, actual, pred: {MODEL:val}, error_pct: {MODEL:pct} }] }
 */
export async function fetchPredictHistory({ ticker, models, days = 12 }) {
  // We need to .append() multiple models=... keys, so build manually
  const url = new URL(`${API_BASE}/predict_history`);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("days", String(days));
  const list = Array.isArray(models)
    ? models
    : String(models || "")
        .split(",")
        .map((s) => s && s.trim())
        .filter(Boolean);
  list.forEach((m) => url.searchParams.append("models", m));
  url.searchParams.set("_ts", Date.now().toString());

  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

export async function fetchQuote(ticker) {
  const url = buildURL("/quote", { ticker });
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

export async function fetchEarnings(ticker) {
  const url = buildURL("/earnings", { ticker });
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

// (unused but kept)
export async function fetchDividends(ticker) {
  const url = buildURL("/dividends", { ticker });
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

export async function fetchMarket() {
  const url = buildURL("/market");
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

export async function fetchCloses(ticker, days = 7) {
  const url = buildURL("/closes", { ticker, days });
  const payload = await handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));

  // Light sanity normalization: ensure arrays exist & lengths match
  const dates = Array.isArray(payload?.dates) ? payload.dates : [];
  const closes = Array.isArray(payload?.closes) ? payload.closes : [];
  if (dates.length !== closes.length) {
    // If mismatched, return the shortest aligned slice rather than throwing
    const n = Math.min(dates.length, closes.length);
    return { ticker: payload?.ticker || ticker, dates: dates.slice(0, n), closes: closes.slice(0, n) };
  }
  return { ticker: payload?.ticker || ticker, dates, closes };
}

// Quick stats (52w high/low)
export async function fetchStats(ticker) {
  const url = buildURL("/stats", { ticker });
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

/**
 * Helper (optional): build the SSE URL for quote streaming in App.jsx
 *   use: buildQuoteStreamURL(ticker, 5)
 */
export function buildQuoteStreamURL(ticker, interval = 5) {
  const url = buildURL("/quote_stream", { ticker, interval });
  // No cache-buster needed for streams, but harmless if present.
  return url.toString();
}
