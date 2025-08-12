import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchPredict,
  fetchQuote,
  fetchEarnings,
  fetchMarket,
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
              <h2 style={{ marginTop: 0 }}>💰 Current Price ({ticker})</h2>
              {quoteErr ? (
                <p className="muted" style={{ color: "#ff6b6b", margin: 0 }}>
                  Error loading quote
                </p>
              ) : quote ? (
                <>
                  <p style={{ margin: 0 }}>Last Close: ${Number(quote.last_close).toFixed(2)}</p>
                  <p style={{ margin: 0 }}>
                    ${tweenPrice.toFixed(2)}{" "}
                    {quote.change_pct >= 0 ? "🔺" : "🔻"}{" "}
                    {Math.abs(Number(quote.change_pct)).toFixed(2)}%
                  </p>
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
    </div>
  );
}
