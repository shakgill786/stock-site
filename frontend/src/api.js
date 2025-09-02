// frontend/src/api.js

// --- Base URL resolution (env first; safe defaults) ---
const RAW_ENV_BASE =
  import.meta.env.VITE_API_BASE ||
  import.meta.env.VITE_API_BASE_URL ||
  "";

// optional hardcoded fallback for production hosting (edit if helpful)
const HARDCODE_BACKEND =
  typeof window !== "undefined" && window.location.hostname.includes("onrender.com")
    ? "https://stock-backend-ddfx.onrender.com"
    : "";

// If no env base provided, try the hardcoded; else fall back to localhost (dev)
const RAW_BASE = RAW_ENV_BASE || HARDCODE_BACKEND || "http://127.0.0.1:8000";

// Normalize: strip trailing slashes
export const API_BASE = String(RAW_BASE).replace(/\/+$/, "");

// Warn about common mixed-content misconfig: https page calling http backend
if (typeof window !== "undefined") {
  const isHttpsPage = window.location.protocol === "https:";
  if (isHttpsPage && API_BASE.startsWith("http://")) {
    // eslint-disable-next-line no-console
    console.warn(
      `[api] API_BASE is HTTP (${API_BASE}) on an HTTPS page. Browsers will block requests. ` +
        `Set VITE_API_BASE to an HTTPS backend URL.`
    );
  }
  // eslint-disable-next-line no-console
  console.info("[api] API_BASE =", API_BASE);
}

// -------- fetch helpers --------
const DEFAULT_RETRIES = 1; // extra attempts after the first
const RETRY_DELAY_MS = 350;
const REQUEST_TIMEOUT_MS = 10000; // 10s network timeout

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

function withTimeout(fetchPromise, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new DOMException("Timeout", "TimeoutError")), ms);
  return fetchPromise(ctrl.signal).finally(() => clearTimeout(id));
}

// Wrap fetch with small retry on network/5xx/429 + timeout
async function fetchWithRetry(url, options = {}, retries = DEFAULT_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(
        (signal) => fetch(url, { ...options, signal }),
        REQUEST_TIMEOUT_MS
      );
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
  if (!res || typeof res.ok !== "boolean") {
    throw new Error("Network error (no response)");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.detail || err?.message;
    } catch {
      try {
        const text = await res.text();
        detail = text?.slice?.(0, 300);
      } catch { /* ignore */ }
    }
    const msg = detail ? `${res.status} ${res.statusText} – ${detail}` : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  // parse JSON (tolerate empty body)
  const txt = await res.text();
  return txt ? JSON.parse(txt) : {};
}

// -------- API functions --------

export async function ping() {
  const url = buildURL("/hello");
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

export async function fetchHello() {
  return ping();
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
  const payload = await handle(
    await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" })
  );

  // Light sanity normalization: ensure arrays exist & lengths match
  const dates = Array.isArray(payload?.dates) ? payload.dates : [];
  const closes = Array.isArray(payload?.closes) ? payload.closes : [];
  if (dates.length !== closes.length) {
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

/** SSE URL for quote streaming */
export function buildQuoteStreamURL(ticker, interval = 5) {
  const url = buildURL("/quote_stream", { ticker, interval });
  return url.toString();
}

// ---------- Movers / Earnings week (missing in older file) ----------

/** Combined movers (gainers + losers) */
export async function fetchMovers() {
  const url = buildURL("/movers");
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

/** Convenience: only top gainers */
export async function fetchTopGainers() {
  const url = buildURL("/top_gainers");
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

/** Convenience: only top losers */
export async function fetchTopLosers() {
  const url = buildURL("/top_losers");
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

/** Earnings calendar for this week */
export async function fetchEarningsWeek() {
  const url = buildURL("/earnings_week");
  return handle(await fetchWithRetry(url, { headers: defaultGetHeaders, cache: "no-store" }));
}

export async function fetchMovers() {
  const url = new URL(`${API_BASE}/movers`);
  url.searchParams.set("_ts", Date.now().toString());
  const res = await fetch(url, { headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" }, cache: "no-store" });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export async function fetchEarningsWeek() {
  const url = new URL(`${API_BASE}/earnings_week`);
  url.searchParams.set("_ts", Date.now().toString());
  const res = await fetch(url, { headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" }, cache: "no-store" });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}