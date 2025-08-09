// frontend/src/techApi.js
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

export async function fetchRSI(ticker) {
  const res = await fetch(`${API_BASE}/rsi?ticker=${encodeURIComponent(ticker)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { period: 14, values: number[] }
}

export async function fetchCorrelation(ticker) {
  const res = await fetch(`${API_BASE}/correlation?ticker=${encodeURIComponent(ticker)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { SPY: number, XLK: number, XLF: number, VIX: number, TNX: number }
}
