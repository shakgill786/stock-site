// frontend/src/techApi.js

const API_BASE =
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    (import.meta.env.VITE_API_BASE || import.meta.env.VITE_API_BASE_URL)) ||
  "http://127.0.0.1:8000";

// Normalize RSI to legacy shape { period, values }
const normalizeRSI = (js, fallbackPeriod = 14) => {
  if (!js) return { period: fallbackPeriod, values: [] };
  if (Array.isArray(js.values)) {
    return { period: js.period ?? fallbackPeriod, values: js.values.map(Number) };
  }
  if (Array.isArray(js.series)) {
    return { period: js.period ?? fallbackPeriod, values: js.series.map((d) => Number(d.rsi)) };
  }
  return { period: fallbackPeriod, values: [] };
};

// Normalize correlation to legacy dict {SYMBOL: corr}
const normalizeCorr = (js) => {
  if (!js) return {};
  if (Array.isArray(js.results)) {
    const out = {};
    for (const r of js.results) {
      if (r?.symbol && typeof r.corr === "number") out[r.symbol] = r.corr;
    }
    return out;
  }
  return js; // already a dict
};

export async function fetchRSI(ticker, period = 14, days = 100) {
  const t = String(ticker || "").toUpperCase().trim();
  const url = `${API_BASE}/rsi?ticker=${encodeURIComponent(t)}&period=${period}&days=${days}&_=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSI HTTP ${res.status}`);
  const js = await res.json();
  const norm = normalizeRSI(js, period);
  // DEBUG: uncomment to inspect
  // console.log("fetchRSI raw:", js, "norm:", norm);
  return norm;
}

export async function fetchCorrelation(ticker, days = 60) {
  const t = String(ticker || "").toUpperCase().trim();
  const url = `${API_BASE}/correlation?ticker=${encodeURIComponent(t)}&days=${days}&_=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Correlation HTTP ${res.status}`);
  const js = await res.json();
  const norm = normalizeCorr(js);
  // DEBUG: uncomment to inspect
  // console.log("fetchCorrelation raw:", js, "norm:", norm);
  return norm;
}
