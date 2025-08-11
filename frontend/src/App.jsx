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
    <div style={{ padding: 20, maxWidth: 1100, margin: "auto", display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
      {/* LEFT: Watchlist */}
      <div>
        <WatchlistPanel current={ticker} onLoad={(s) => setTicker(s)} />
        <div style={{ marginTop: 12 }}>
          <label>
            <input type="checkbox" checked={live} onChange={() => setLive((v) => !v)} /> Live price updates (SSE)
          </label>
        </div>
      </div>

      {/* RIGHT: Main content */}
      <div>
        <h1>Real-Time Stock & Crypto Dashboard</h1>

        <form onSubmit={handleSubmit} style={{ marginBottom: 16, display: "flex", gap: 8 }}>
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="Ticker (e.g. AAPL or BTC-USD)"
            required
          />
          <button disabled={loading}>{loading ? "Loading…" : "Load Data"}</button>
        </form>

        {/* Top info row */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 12 }}>
          {/* Quote Card */}
          <div style={cardStyle} className={blinkClass}>
            <h2 style={{ marginTop: 0 }}>💰 Current Price ({ticker})</h2>
            {quoteErr ? (
              <p style={{ color: "red", margin: 0 }}>Error loading quote</p>
            ) : quote ? (
              <>
                <p style={{ margin: 0 }}>Last Close: ${Number(quote.last_close).toFixed(2)}</p>
                <p style={{ margin: 0 }}>
                  ${tweenPrice.toFixed(2)}{" "}
                  {quote.change_pct >= 0 ? "🔺" : "🔻"} {Math.abs(Number(quote.change_pct)).toFixed(2)}%
                </p>
              </>
            ) : (
              <p style={{ color: "#666", margin: 0 }}>N/A</p>
            )}
          </div>

          {/* Earnings */}
          <EarningsCard earnings={earnings} />

          {/* Recommendation */}
          <RecommendationCard recommendation={recommendation} />
        </div>

        {/* Market Breadth */}
        {market && <MarketCard market={market} />}

        {/* Metrics list */}
        {!!metrics.length && <MetricsList metrics={metrics} />}

        {/* Prediction Error */}
        {error && <p style={{ color: "red" }}>Prediction Error: {error}</p>}

        {/* Model selector */}
        <div style={{ marginTop: 12, marginBottom: 8 }}>
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

        {/* Forecast Table */}
        {results.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Model</th>
                {results[0].predictions.map((_, i) => (
                  <th key={i} style={thStyle}>{`+${i + 1}d`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map(({ model, predictions }) => (
                <tr key={model}>
                  <td style={tdStyle}>{model}</td>
                  {predictions.map((val, i) => (
                    <td key={i} style={tdStyle}>{val}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 16,
  minWidth: 300,
  flex: "0 1 320px",
};

const tableStyle = {
  borderCollapse: "collapse",
  width: "100%",
  marginTop: 24,
};

const thStyle = {
  border: "1px solid #ddd",
  padding: 8,
  background: "#f0f0f0",
  textAlign: "left",
};

const tdStyle = {
  border: "1px solid #ddd",
  padding: 8,
};
