// frontend/src/api.js
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://127.0.0.1:8000";

// Small helper for consistent error handling
async function handle(res) {
  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.detail;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchHello() {
  return handle(await fetch(`${API_BASE}/hello`));
}

export async function fetchPredict({ ticker, models }) {
  return handle(
    await fetch(`${API_BASE}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, models }),
    })
  );
}

/**
 * Retrospective “next-day” history for the last N trading days.
 * Returns: { ticker, models, rows: [{ date, close, actual, pred: {MODEL:val}, error_pct: {MODEL:pct} }] }
 */
export async function fetchPredictHistory({ ticker, models, days = 12 }) {
  const url = new URL(`${API_BASE}/predict_history`);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("days", String(days));
  (Array.isArray(models) ? models : String(models || "").split(","))
    .map((s) => s && s.trim())
    .filter(Boolean)
    .forEach((m) => url.searchParams.append("models", m));
  return handle(await fetch(url.toString()));
}

export async function fetchQuote(ticker) {
  return handle(
    await fetch(`${API_BASE}/quote?ticker=${encodeURIComponent(ticker)}`)
  );
}

export async function fetchEarnings(ticker) {
  return handle(
    await fetch(`${API_BASE}/earnings?ticker=${encodeURIComponent(ticker)}`)
  );
}

// (unused but kept)
export async function fetchDividends(ticker) {
  return handle(
    await fetch(`${API_BASE}/dividends?ticker=${encodeURIComponent(ticker)}`)
  );
}

export async function fetchMarket() {
  return handle(await fetch(`${API_BASE}/market`));
}

export async function fetchCloses(ticker, days = 7) {
  return handle(
    await fetch(
      `${API_BASE}/closes?ticker=${encodeURIComponent(ticker)}&days=${days}`
    )
  );
}

// Quick stats (52w high/low)
export async function fetchStats(ticker) {
  return handle(
    await fetch(`${API_BASE}/stats?ticker=${encodeURIComponent(ticker)}`)
  );
}
