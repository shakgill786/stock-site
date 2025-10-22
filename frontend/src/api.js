// frontend/src/api.js
// ------------------------------------------------------------
// Unified API client with resilient auth path probing.
// - Env-first base URL
// - Safe strict mode (won’t get stuck on legacy /auth/auth/*)
// - Legacy /auth/auth/* left as LAST resort only
// ------------------------------------------------------------

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
const AUTH_ENABLED =
  String(import.meta.env.VITE_AUTH_ENABLED ?? "true").toLowerCase() === "true";

const AUTH_STRICT = ["true", "1", "yes"].includes(
  String(
    import.meta.env.VITE_AUTH_STRICT ??
      import.meta.env.VITE_AUTH_STRICT_PATHS ??
      "false"
  ).toLowerCase()
);

const ENV_LOGIN = import.meta.env.VITE_AUTH_LOGIN_PATH || "";
const ENV_REGISTER = import.meta.env.VITE_AUTH_REGISTER_PATH || "";
const ENV_ME = import.meta.env.VITE_AUTH_ME_PATH || "";

const LOGIN_PATHS = [
  ENV_LOGIN || null,
  "/auth/login",
  "/login",
  "/users/login",
  "/signin",
  "/token",
  "/auth/auth/login", // legacy LAST
].filter(Boolean);

const REGISTER_PATHS = [
  ENV_REGISTER || null,
  "/auth/register",
  "/register",
  "/users/register",
  "/signup",
  "/auth/auth/register", // legacy LAST
].filter(Boolean);

const ME_PATHS = [
  ENV_ME || null,
  "/auth/me",
  "/me",
  "/users/me",
  "/auth/auth/me", // legacy LAST
].filter(Boolean);

if (typeof window !== "undefined") {
  const isHttpsPage = window.location.protocol === "https:";
  if (isHttpsPage && API_BASE.startsWith("http://")) {
    console.warn(
      `[api] API_BASE is HTTP (${API_BASE}) on an HTTPS page. Browsers will block requests. ` +
        `Set VITE_API_BASE to an HTTPS backend URL.`
    );
  }
  console.info("[api] API_BASE =", API_BASE);
  console.info("[api] AUTH_ENABLED =", AUTH_ENABLED, "AUTH_STRICT =", AUTH_STRICT);
  if (AUTH_ENABLED) {
    console.info(
      "[api] Auth paths (first choices) =",
      LOGIN_PATHS[0],
      REGISTER_PATHS[0],
      ME_PATHS[0],
      "| strict =",
      AUTH_STRICT
    );
  }
}

// -------- auth token helpers --------
const TOKEN_KEY = "AUTH_TOKEN";

export function setAuthToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token || "");
  } catch {}
}
export function getAuthToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}
export function clearAuthToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// -------- fetch helpers --------
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 350;
const REQUEST_TIMEOUT_MS = 10000;

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
  if (params && typeof params === "object") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  url.searchParams.set("_ts", Date.now().toString());
  return url;
}

function withTimeout(fetcher, ms, externalSignal) {
  const ctrl = new AbortController();

  if (externalSignal instanceof AbortSignal) {
    if (externalSignal.aborted) {
      try { ctrl.abort(externalSignal.reason); } catch { ctrl.abort(); }
    } else {
      const onAbort = () => { try { ctrl.abort(externalSignal.reason); } catch { ctrl.abort(); } };
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const id = setTimeout(() => {
    try { ctrl.abort(new DOMException("Timeout", "TimeoutError")); } catch { ctrl.abort(); }
  }, ms);

  return fetcher(ctrl.signal).finally(() => clearTimeout(id));
}

async function fetchWithRetry(url, options = {}, retries = DEFAULT_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(
        (signal) => fetch(url, { ...options, signal }),
        REQUEST_TIMEOUT_MS,
        options.signal
      );
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
      if (e?.name === "AbortError") throw e;
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr;
}

function firstTryList(paths) {
  const first = paths[0] || "";
  if (AUTH_STRICT && !first.includes("/auth/auth/")) return [first];
  return paths;
}

async function getFirst(paths, headers = defaultGetHeaders) {
  const list = firstTryList(paths);
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
  const list = firstTryList(paths);
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
      } catch {}
    }
    const msg = detail ? `${res.status} ${res.statusText} – ${detail}` : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : {};
}

// -------- API functions --------

export async function ping(opts) {
  const url = buildURL("/diag");
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}
export async function fetchHello(opts) {
  return ping(opts);
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

/** SSE URL for sentiment alerts (server expects single `ticker`) */
export function buildSentimentStreamURL({ ticker, days = 60, interval = 60 } = {}) {
  const url = new URL(`${API_BASE}/sentiment/alerts_stream`);
  if (ticker) url.searchParams.set("ticker", String(ticker));
  url.searchParams.set("days", String(days));
  url.searchParams.set("interval", String(interval));
  url.searchParams.set("_ts", Date.now().toString());
  const tok = getAuthToken();
  if (tok) url.searchParams.set("token", tok);
  return url.toString();
}

// --- Predictions & data ---
export async function fetchPredict({ ticker, models }, opts) {
  const url = buildURL("/predict");
  return handle(
    await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: maybeAuth(defaultPostHeaders),
        body: JSON.stringify({ ticker, models }),
        cache: "no-store",
        ...(opts || {}),
      },
      DEFAULT_RETRIES
    )
  );
}

export async function fetchPredictHistory({ ticker, models, days = 12 }, opts) {
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

  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

export async function fetchQuote(ticker, opts) {
  const url = buildURL("/quote", { ticker });
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

export async function fetchEarnings(ticker, opts) {
  const url = buildURL("/earnings", { ticker });
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

export async function fetchDividends(ticker, opts) {
  const url = buildURL("/dividends", { ticker });
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

export async function fetchMarket(opts) {
  const url = buildURL("/market");
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

export async function fetchCloses(ticker, days = 7, opts) {
  const url = buildURL("/closes", { ticker, days });
  const payload = await handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );

  const dates = Array.isArray(payload?.dates) ? payload.dates : [];
  const closes = Array.isArray(payload?.closes) ? payload.closes : [];
  if (dates.length !== closes.length) {
    const n = Math.min(dates.length, closes.length);
    return {
      ticker: payload?.ticker || ticker,
      dates: dates.slice(0, n),
      closes: closes.slice(0, n),
    };
  }
  return { ticker: payload?.ticker || ticker, dates, closes };
}

export async function fetchStats(ticker, opts) {
  const url = buildURL("/stats", { ticker });
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

// ---------- Movers / Earnings week ----------
export async function fetchMovers(opts) {
  const url = buildURL(MOVERS_ENDPOINT);
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

export async function fetchTopGainers(opts) {
  const url = buildURL("/top_gainers");
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

export async function fetchTopLosers(opts) {
  const url = buildURL("/top_losers");
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

// 405-proof (retry with trailing slash) for proxies that require it
export async function fetchEarningsWeek(opts) {
  const url = buildURL(EARNINGS_WEEK_ENDPOINT);
  try {
    return handle(
      await fetchWithRetry(url, {
        headers: maybeAuth(defaultGetHeaders),
        cache: "no-store",
        ...(opts || {}),
      })
    );
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("405")) {
      const path = EARNINGS_WEEK_ENDPOINT.endsWith("/")
        ? EARNINGS_WEEK_ENDPOINT
        : EARNINGS_WEEK_ENDPOINT + "/";
      const url2 = buildURL(path);
      return handle(
        await fetchWithRetry(url2, {
          headers: maybeAuth(defaultGetHeaders),
          cache: "no-store",
          ...(opts || {}),
        })
      );
    }
    throw e;
  }
}

/* ---------------- Sentiment / News ---------------- */
/** Align with backend route name (/sentiment/correlation) */
export async function fetchSentimentCorrelation(ticker, days = 120, opts) {
  const url = new URL(`${API_BASE}/sentiment/correlation`);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("days", String(days));
  url.searchParams.set("_ts", Date.now().toString());
  return handle(
    await fetchWithRetry(url, {
      headers: maybeAuth(defaultGetHeaders),
      cache: "no-store",
      ...(opts || {}),
    })
  );
}

/* Optional stubs (not used by current UI) */
export async function fetchNewsSentiment() { return { items: [] }; }
export async function fetchDailySentiment() { return { daily: [] }; }
export async function fetchSentimentMatrix() { return { matrix: [] }; }
export async function fetchSentimentTopics() { return { topics: [] }; }
