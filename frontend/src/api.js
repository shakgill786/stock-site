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

// Optional env overrides for special endpoints
const MOVERS_ENDPOINT = import.meta.env.VITE_MOVERS_ENDPOINT || "/movers";
const EARNINGS_WEEK_ENDPOINT = import.meta.env.VITE_EARNINGS_WEEK_ENDPOINT || "/earnings_week";

// ---- Auth feature toggles / paths ----
const AUTH_ENABLED = String(import.meta.env.VITE_AUTH_ENABLED ?? "true").toLowerCase() === "true";
const AUTH_STRICT = String(import.meta.env.VITE_AUTH_STRICT_PATHS ?? "false").toLowerCase() === "true";

const ENV_LOGIN = import.meta.env.VITE_AUTH_LOGIN_PATH || "";
const ENV_REGISTER = import.meta.env.VITE_AUTH_REGISTER_PATH || "";
const ENV_ME = import.meta.env.VITE_AUTH_ME_PATH || "";

// Build ordered fallback lists. We’ll try each until we get a non-404.
const LOGIN_PATHS = [
  ENV_LOGIN || null,
  "/auth/login",
  "/auth/auth/login",
  "/login",
  "/users/login",
  "/signin",
  "/token", // some backends use OAuth2 Password Grant as /token
].filter(Boolean);

const REGISTER_PATHS = [
  ENV_REGISTER || null,
  "/auth/register",
  "/auth/auth/register",
  "/register",
  "/users/register",
  "/signup",
].filter(Boolean);

const ME_PATHS = [
  ENV_ME || null,
  "/auth/me",
  "/auth/auth/me",
  "/me",
  "/users/me",
].filter(Boolean);

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
  // eslint-disable-next-line no-console
  console.info("[api] AUTH_ENABLED =", AUTH_ENABLED, "AUTH_STRICT =", AUTH_STRICT);
  if (AUTH_ENABLED) {
    // eslint-disable-next-line no-console
    console.info("[api] Auth paths (login/register/me) =", LOGIN_PATHS[0], REGISTER_PATHS[0], ME_PATHS[0]);
  }
}

// -------- auth token helpers --------
const TOKEN_KEY = "AUTH_TOKEN";

export function setAuthToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token || ""); } catch {}
}
export function getAuthToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function clearAuthToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
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

function maybeAuth(headers = {}) {
  const t = getAuthToken();
  return t ? { ...headers, Authorization: `Bearer ${t}` } : headers;
}

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

function withTimeout(fetcher, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new DOMException("Timeout", "TimeoutError")), ms);
  return fetcher(ctrl.signal).finally(() => clearTimeout(id));
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

// Try multiple paths, skipping 404s
async function getFirst(paths, headers = defaultGetHeaders) {
  const list = AUTH_STRICT ? [paths[0]] : paths;
  let lastErr;
  for (const p of list) {
    try {
      const url = buildURL(p);
      const res = await fetchWithRetry(url, { headers, cache: "no-store" });
      if (res.status === 404) continue;
      return handle(res);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All endpoints returned 404");
}

async function postJsonFirst(paths, body, headers = defaultPostHeaders) {
  const list = AUTH_STRICT ? [paths[0]] : paths;
  let lastErr;
  for (const p of list) {
    try {
      const url = buildURL(p);
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (res.status === 404) continue;
      return handle(res);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All endpoints returned 404");
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
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}
export async function fetchHello() {
  return ping();
}

// --- Auth ---
export async function register({ email, password }) {
  if (!AUTH_ENABLED) return { disabled: true };
  const data = await postJsonFirst(REGISTER_PATHS, { email, password }, defaultPostHeaders);
  if (data?.access_token) setAuthToken(data.access_token);
  return data;
}

export async function login({ email, password }) {
  if (!AUTH_ENABLED) return { disabled: true };
  // Most backends here expect JSON {email,password}; if your backend uses OAuth2 /token,
  // set VITE_AUTH_LOGIN_PATH=/token and adjust server to accept form-encoded.
  const data = await postJsonFirst(LOGIN_PATHS, { email, password }, defaultPostHeaders);
  if (data?.access_token) setAuthToken(data.access_token);
  return data;
}

export async function me() {
  if (!AUTH_ENABLED) return {};
  return getFirst(ME_PATHS, maybeAuth(defaultGetHeaders));
}

/** SSE URL for quote streaming (passes token via query if present) */
export function buildQuoteStreamURL(ticker, interval = 5) {
  const url = buildURL("/quote_stream", { ticker, interval });
  const tok = getAuthToken();
  if (tok) url.searchParams.set("token", tok);
  return url.toString();
}

// --- Predictions & data ---
export async function fetchPredict({ ticker, models }) {
  const url = buildURL("/predict");
  return handle(
    await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: maybeAuth(defaultPostHeaders),
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

  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

export async function fetchQuote(ticker) {
  const url = buildURL("/quote", { ticker });
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

export async function fetchEarnings(ticker) {
  const url = buildURL("/earnings", { ticker });
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

// (unused but kept)
export async function fetchDividends(ticker) {
  const url = buildURL("/dividends", { ticker });
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

export async function fetchMarket() {
  const url = buildURL("/market");
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

export async function fetchCloses(ticker, days = 7) {
  const url = buildURL("/closes", { ticker, days });
  const payload = await handle(
    await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" })
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
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

// ---------- Movers / Earnings week ----------
/** Combined movers (gainers + losers) */
export async function fetchMovers() {
  const url = buildURL(MOVERS_ENDPOINT);
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

/** Convenience: only top gainers */
export async function fetchTopGainers() {
  const url = buildURL("/top_gainers");
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

/** Convenience: only top losers */
export async function fetchTopLosers() {
  const url = buildURL("/top_losers");
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}

/** Earnings calendar for this week (Mon–Sun) */
export async function fetchEarningsWeek() {
  const url = buildURL(EARNINGS_WEEK_ENDPOINT);
  return handle(await fetchWithRetry(url, { headers: maybeAuth(defaultGetHeaders), cache: "no-store" }));
}
