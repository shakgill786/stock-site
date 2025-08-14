import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchPredict,
  fetchQuote,
  fetchEarnings,
  fetchMarket,
  fetchCloses, // ⬅️ added
} from "./api";
import MarketCard from "./components/MarketCard";
import EarningsCard from "./components/EarningsCard";
import RecommendationCard from "./components/RecommendationCard";
import MetricsList from "./components/MetricsList";
import WatchlistPanel from "./components/WatchlistPanel";
import useEventSource from "./hooks/useEventSource";
import useTweenNumber from "./hooks/useTweenNumber";
import CompareMode from "./components/CompareMode";
import "./App.css";

const MODEL_OPTIONS = ["LSTM", "ARIMA", "RandomForest", "XGBoost"];
const API_BASE =
  (import.meta.env.VITE_API_BASE || import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000");

export default function App() {
  const [ticker, setTicker] = useState("AAPL");
  const [models, setModels] = useState(["LSTM", "ARIMA"]);

  // Data states
  const [quote, setQuote] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [market, setMarket] = useState(null);

  // Errors
  const [quoteErr, setQuoteErr] = useState(false);
  const [earningsErr, setEarningsErr] = useState(false);

  // Predictions
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Live stream
  const [live, setLive] = useState(true);
  const prevPriceRef = useRef(null);
  const tweenPrice = useTweenNumber(quote?.current_price ?? 0, { duration: 450 });
  const [blinkClass, setBlinkClass] = useState("");

  // Compare Mode
  const [compareOpen, setCompareOpen] = useState(false);

  // Price chart data (main card)
  const [closes, setCloses] = useState([]);
  const [closeDates, setCloseDates] = useState([]);
  const [showBigPriceChart, setShowBigPriceChart] = useState(false);

  // helpers (mirror CompareMode)
  const normalizeCloses = (arr) => {
    if (!Array.isArray(arr)) return [];
    const cleaned = arr.map(Number).filter((v) => Number.isFinite(v));
    return cleaned.length >= 2 ? cleaned : [];
  };

  const fetchClosesSafe = async (tkr) => {
    try {
      const a = await fetchCloses(tkr, 1825); // ~5 years
      let c = normalizeCloses(a?.closes);
      if (c.length >= 2) return { dates: Array.isArray(a?.dates) ? a.dates : [], closes: c };

      // retry looser (backend default)
      const b = await fetchCloses(tkr);
      c = normalizeCloses(b?.closes);
      return { dates: Array.isArray(b?.dates) ? b.dates : [], closes: c };
    } catch {
      return { dates: [], closes: [] };
    }
  };

  const loadData = useCallback(async () => {
    setQuoteErr(false);
    setEarningsErr(false);
    setError("");

    const t = String(ticker || "").toUpperCase().trim();

    // 1) Quote
    try {
      const q = await fetchQuote(t);
      setQuote(q);
      prevPriceRef.current = q.current_price;
    } catch {
      setQuoteErr(true);
      setQuote(null);
    }

    // 2) Earnings
    try {
      const e = await fetchEarnings(t);
      setEarnings(e);
    } catch {
      setEarningsErr(true);
      setEarnings(null);
    }

    // 3) Market
    try {
      const m = await fetchMarket();
      setMarket(m);
    } catch {
      setMarket(null);
    }

    // 3.5) Closes for the price chart
    try {
      const { closes: c, dates: d } = await fetchClosesSafe(t);
      setCloses(c);
      setCloseDates(d);
    } catch {
      setCloses([]);
      setCloseDates([]);
    }

    // 4) Predictions
    setLoading(true);
    try {
      const { results } = await fetchPredict({ ticker: t, models });
      setResults(results);
    } catch (e) {
      setError(e.message || "Prediction fetch failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [ticker, models]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Live SSE: only updates the quote card smoothly
  const streamUrl = live ? `${API_BASE}/quote_stream?ticker=${encodeURIComponent(ticker)}&interval=5` : null;

  useEventSource(streamUrl, {
    enabled: !!streamUrl,
    onMessage: (payload) => {
      const prev = prevPriceRef.current;
      const next = Number(payload.current_price);
      if (typeof next === "number" && !Number.isNaN(next)) {
        setQuote((q) =>
          q
            ? { ...q, current_price: next, change_pct: payload.change_pct }
            : {
                ticker: payload.ticker,
                current_price: next,
                last_close: payload.last_close,
                change_pct: payload.change_pct,
              }
        );
        if (typeof prev === "number" && !Number.isNaN(prev) && prev !== next) {
          setBlinkClass(next > prev ? "blink-up" : "blink-down");
          setTimeout(() => setBlinkClass(""), 520);
        }
        prevPriceRef.current = next;
      }
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    loadData();
  };

  const toggleModel = (m) =>
    setModels((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    );

  // Client-side metrics & recommendation
  const metrics = useMemo(() => {
    if (!quote || !results?.length) return [];
    const base = Number(quote.last_close) || 0;
    if (base <= 0) return [];

    return results.map((r) => {
      const mapeProxy =
        r.predictions.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) /
        r.predictions.length;
      const meanPred =
        r.predictions.reduce((a, b) => a + b, 0) / r.predictions.length;
      const avgChangePct = ((meanPred - base) / base) * 100;
      return { model: r.model, mapeProxy, avgChangePct };
    });
  }, [quote, results]);

  const recommendation = useMemo(() => {
    if (!metrics.length) return null;
    const best = [...metrics].sort((a, b) => a.mapeProxy - b.mapeProxy)[0];
    let action = "Hold";
    if (best.avgChangePct > 1) action = "Buy";
    if (best.avgChangePct < -1) action = "Sell";
    return { ...best, action };
  }, [metrics]);

  return (
    <div className="app-root">
      {/* Top header (sticky at top, no overlap) */}
      <header className="app-header">
        <h1>Real-Time Stock & Crypto Dashboard</h1>
      </header>

      <main className="container grid-2col">
        {/* LEFT: Watchlist */}
        <aside className="left-rail">
          <WatchlistPanel current={ticker} onLoad={(s) => setTicker(s)} />
          <div style={{ marginTop: 12 }}>
            <label>
              <input
                type="checkbox"
                checked={live}
                onChange={() => setLive((v) => !v)}
              />{" "}
              Live price updates (SSE)
            </label>
          </div>
        </aside>

        {/* RIGHT: Main content */}
        <section>
          {/* Compare Mode Toggle */}
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <button className="btn" onClick={() => setCompareOpen((v) => !v)}>
              {compareOpen ? "Close Compare" : "Open Compare"}
            </button>
          </div>

          {compareOpen && (
            <CompareMode
              defaultModels={models}
              onExit={() => setCompareOpen(false)}
            />
          )}

          <form onSubmit={handleSubmit} className="row" style={{ marginBottom: 16 }}>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="Ticker (e.g. AAPL or BTC-USD)"
              required
              type="text"
            />
            <button className="btn" disabled={loading}>
              {loading ? "Loading…" : "Load Data"}
            </button>
          </form>

          {/* Top info row */}
          <div className="row" style={{ gap: 16, marginBottom: 12 }}>
            {/* Quote Card */}
            <div className={`card ${blinkClass}`} style={{ minWidth: 300, flex: "0 1 320px" }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <h2 style={{ marginTop: 0 }}>💰 Current Price ({ticker})</h2>
                {closes.length > 0 && (
                  <button
                    className="btn ghost"
                    onClick={() => setShowBigPriceChart(true)}
                    style={{ padding: "2px 8px", fontSize: 12 }}
                    title="Magnify chart"
                  >
                    🔍 Magnify
                  </button>
                )}
              </div>

              {quoteErr ? (
                <p className="muted" style={{ color: "#ff6b6b", margin: 0 }}>
                  Error loading quote
                </p>
              ) : quote ? (
                <>
                  <p style={{ margin: 0 }}>Last Close: ${Number(quote.last_close).toFixed(2)}</p>
                  <p style={{ margin: 0 }}>
                    ${tweenPrice.toFixed(2)}{" "}
                    {Number.isFinite(Number(quote?.change_pct)) && (
                      <span
                        style={{
                          color: Number(quote.change_pct) >= 0 ? "#2e7d32" : "#c62828",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                        aria-label={`${
                          Number(quote.change_pct) >= 0 ? "Up" : "Down"
                        } ${Math.abs(Number(quote.change_pct)).toFixed(2)} percent`}
                        title={`${
                          Number(quote.change_pct) >= 0 ? "Up" : "Down"
                        } ${Math.abs(Number(quote.change_pct)).toFixed(2)}%`}
                      >
                        {Number(quote.change_pct) >= 0 ? "▲" : "▼"}{" "}
                        {Math.abs(Number(quote.change_pct)).toFixed(2)}%
                      </span>
                    )}
                  </p>

                  {/* mini interactive chart */}
                  <div style={{ marginTop: 8 }}>
                    {closes.length >= 2 ? (
                      <InteractivePriceChart data={closes} labels={closeDates} width={320} height={80} />
                    ) : (
                      <div className="muted" style={{ fontSize: 12 }}>no chart data</div>
                    )}
                  </div>
                  {closes.length >= 2 && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      drag to pan • wheel to zoom • double-click to reset
                    </div>
                  )}
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>N/A</p>
              )}
            </div>

            {/* Earnings */}
            <div className="card" style={{ minWidth: 300, flex: "0 1 320px" }}>
              <EarningsCard earnings={earnings} />
            </div>

            {/* Recommendation */}
            <div className="card" style={{ minWidth: 300, flex: "0 1 320px" }}>
              <RecommendationCard recommendation={recommendation} />
            </div>
          </div>

          {/* Market Breadth */}
          {market && (
            <div className="card">
              <MarketCard market={market} />
            </div>
          )}

          {/* Metrics list */}
          {!!metrics.length && (
            <div className="card" style={{ marginTop: 12, marginBottom: 12 }}>
              <MetricsList metrics={metrics} />
            </div>
          )}

          {/* Prediction Error */}
          {error && <p style={{ color: "red" }}>Prediction Error: {error}</p>}

          {/* Model selector */}
          <div className="row" style={{ marginTop: 12, marginBottom: 8 }}>
            {MODEL_OPTIONS.map((m) => (
              <label key={m} style={{ marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={models.includes(m)}
                  onChange={() => toggleModel(m)}
                />{" "}
                {m}
              </label>
            ))}
          </div>

          {/* Forecast Table (wrapped to ensure no white bleed + proper overflow) */}
          {results.length > 0 && (
            <div className="card table-card">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      {results[0].predictions.map((_, i) => (
                        <th key={i}>{`+${i + 1}d`}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map(({ model, predictions }) => (
                      <tr key={model}>
                        <td>{model}</td>
                        {predictions.map((val, i) => (
                          <td key={i}>{Number(val).toFixed(2)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Big chart modal */}
      {showBigPriceChart && (
        <MagnifyModal title={`${ticker} • Price`} onClose={() => setShowBigPriceChart(false)}>
          <InteractivePriceChart data={closes || []} labels={closeDates || []} width={800} height={300} big />
        </MagnifyModal>
      )}
    </div>
  );
}

/** Interactive SVG line chart with hover scrub, drag-pan, wheel-zoom + date labels */
function InteractivePriceChart({ data = [], labels = [], width = 320, height = 80, big = false }) {
  const pad = 10;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const [view, setView] = useState({ start: 0, end: Math.max(0, data.length - 1) });
  const [cursorX, setCursorX] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [drag, setDrag] = useState(null); // {startX, startView}

  // reset view if data length changes
  useEffect(() => {
    setView({ start: 0, end: Math.max(0, data.length - 1) });
  }, [data.length]);

  if (!Array.isArray(data) || data.length < 2) {
    return <div className="muted" style={{ fontSize: 12 }}>no data</div>;
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const vStart = clamp(view.start, 0, data.length - 2);
  const vEnd   = clamp(view.end,   vStart + 1, data.length - 1);
  const windowData = data.slice(vStart, vEnd + 1);

  const min = Math.min(...windowData);
  const max = Math.max(...windowData);
  const range = max - min || 1;

  const xForIndex = (i) => pad + (w * (i - vStart)) / (vEnd - vStart);
  const idxForX = (x) => {
    const t = clamp((x - pad) / w, 0, 1);
    return Math.round(vStart + t * (vEnd - vStart));
  };
  const yForVal = (v) => pad + h - ((v - min) / range) * h;

  const points = windowData.map((v, k) => {
    const i = vStart + k;
    return `${xForIndex(i)},${yForVal(v)}`;
  }).join(" ");

  const lastUp = windowData[windowData.length - 1] >= windowData[0];

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setCursorX(clamp(x, pad, pad + w));
    setHoverIdx(idxForX(x));
    // drag-to-pan
    if (drag) {
      const dx = x - drag.startX;
      const frac = dx / w;
      const windowSize = drag.startView.end - drag.startView.start;
      let newStart = drag.startView.start - Math.round(frac * windowSize);
      let newEnd = newStart + windowSize;
      if (newStart < 0) { newStart = 0; newEnd = windowSize; }
      if (newEnd > data.length - 1) { newEnd = data.length - 1; newStart = newEnd - windowSize; }
      setView({ start: newStart, end: newEnd });
    }
  };

  const onLeave = () => { setCursorX(null); setHoverIdx(null); setDrag(null); };
  const onDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setDrag({ startX: x, startView: { ...view } });
  };
  const onUp = () => setDrag(null);

  const onWheel = (e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, pad, pad + w);
    const focusIdx = idxForX(x);

    const windowSize = vEnd - vStart;
    const delta = Math.sign(e.deltaY); // 1 = out, -1 = in
    const zoomStep = Math.max(1, Math.round(windowSize * 0.15));
    let newSize = delta < 0 ? windowSize - zoomStep : windowSize + zoomStep;
    newSize = clamp(newSize, 5, data.length - 1);

    let newStart = focusIdx - Math.round((focusIdx - vStart) * (newSize / windowSize));
    let newEnd = newStart + newSize;

    if (newStart < 0) { newStart = 0; newEnd = newSize; }
    if (newEnd > data.length - 1) { newEnd = data.length - 1; newStart = newEnd - newSize; }

    setView({ start: newStart, end: newEnd });
  };

  const onDblClick = () => setView({ start: 0, end: data.length - 1 });

  const showIdx = clamp(hoverIdx ?? vEnd, 0, data.length - 1);
  const showVal = data[showIdx];
  const showX = xForIndex(showIdx);
  const showY = yForVal(showVal);

  // label prefers real date when provided
  let label;
  if (Array.isArray(labels) && labels.length === data.length) {
    const d = labels[showIdx];
    try {
      const dt = new Date(d);
      label = dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      label = String(d);
    }
  } else {
    const rel = (data.length - 1) - showIdx; // 0 = latest
    label = rel === 0 ? "latest" : `t-${rel}d`;
  }

  const textW = Math.min(180, 70 + String(label).length * 6);
  const boxX = Math.min(showX + 8, width - (textW + 10));
  const boxY = Math.max(showY - 26, 2);

  return (
    <svg
      width={width}
      height={height}
      style={{ cursor: drag ? "grabbing" : "crosshair", background: "transparent", borderRadius: 8 }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onMouseDown={onDown}
      onMouseUp={onUp}
      onWheel={onWheel}
      onDoubleClick={onDblClick}
    >
      <rect x="0" y="0" width={width} height={height} rx="8" ry="8" fill="rgba(255,255,255,0.03)" />
      <polyline fill="none" stroke={lastUp ? "#2e7d32" : "#c62828"} strokeWidth={big ? 2.5 : 2} points={points} />
      {cursorX != null && (
        <>
          <line x1={showX} x2={showX} y1={pad} y2={pad + h} stroke="#a8b2ff" strokeDasharray="3,3" />
          <circle cx={showX} cy={showY} r={big ? 4 : 3} fill="#a8b2ff" />
          <g>
            <rect x={boxX} y={boxY} width={textW} height="22" rx="6" fill="rgba(0,0,0,0.65)" stroke="rgba(255,255,255,0.25)" />
            <text x={boxX + 10} y={boxY + 15} fontSize={big ? 12 : 11} fill="#fff">
              ${Number(showVal).toFixed(2)} • {label}
            </text>
          </g>
        </>
      )}
    </svg>
  );
}

/** Minimal modal (no deps) */
function MagnifyModal({ title, children, onClose }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(2px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "min(95vw, 1000px)", padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Tip: drag to pan • mouse wheel to zoom • double-click to reset
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}
