// frontend/src/api.js
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

export async function fetchHello() {
  const res = await fetch(`${API_BASE}/hello`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchPredict({ ticker, models }) {
  const res = await fetch(`${API_BASE}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker, models }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchQuote(ticker) {
  const res = await fetch(`${API_BASE}/quote?ticker=${encodeURIComponent(ticker)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchEarnings(ticker) {
  const res = await fetch(`${API_BASE}/earnings?ticker=${encodeURIComponent(ticker)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// (unused but kept)
export async function fetchDividends(ticker) {
  const res = await fetch(`${API_BASE}/dividends?ticker=${encodeURIComponent(ticker)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchMarket() {
  const res = await fetch(`${API_BASE}/market`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchCloses(ticker, days = 7) {
  const res = await fetch(`${API_BASE}/closes?ticker=${encodeURIComponent(ticker)}&days=${days}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { ticker, dates, closes }
}

// quick stats
export async function fetchStats(ticker) {
  const res = await fetch(`${API_BASE}/stats?ticker=${encodeURIComponent(ticker)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Retrospective “next-day” predictions for the last N target dates.
 * Returns: { ticker, models, rows: [{ date, actual, close, pred:{MODEL:number}, error_pct:{MODEL:number} }] }
 */
export async function fetchPredictHistory({ ticker, models, days = 12 }) {
  const url = new URL(`${API_BASE}/predict_history`);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("days", String(days));
  (Array.isArray(models) ? models : String(models || "").split(","))
    .map((s) => s && s.trim())
    .filter(Boolean)
    .forEach((m) => url.searchParams.append("models", m));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
