import { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchPredict,
  fetchQuote,
  fetchEarnings,
  fetchDividends,
  fetchMarket,
} from "./api";
import MarketCard from "./components/MarketCard";
import EarningsCard from "./components/EarningsCard";
import DividendCard from "./components/DividendCard";
import RecommendationCard from "./components/RecommendationCard";
import MetricsList from "./components/MetricsList";
import RSIChart from "./components/RSIChart";
import CorrelationChart from "./components/CorrelationChart";
import "./App.css";

const MODEL_OPTIONS = ["LSTM", "ARIMA", "RandomForest", "XGBoost"];

export default function App() {
  const [ticker, setTicker] = useState("AAPL");
  const [models, setModels] = useState(["LSTM", "ARIMA"]);

  // Data states
  const [quote, setQuote] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [dividends, setDividends] = useState(null);
  const [market, setMarket] = useState(null);

  // Error flags for individual cards
  const [quoteErr, setQuoteErr] = useState(false);
  const [earningsErr, setEarningsErr] = useState(false);
  const [dividendsErr, setDividendsErr] = useState(false);

  // Prediction states
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [autoRefresh, setAutoRefresh] = useState(false);

  // --- NEW: tech states (optional; they render N/A if backend not ready) ---
  const [rsi, setRsi] = useState(null);           // { period: 14, values: number[] }
  const [corr, setCorr] = useState(null);         // { VIX: number, SPY: number, ... }
  const [techErr, setTechErr] = useState(false);

  const loadData = useCallback(async () => {
    // reset errors
    setQuoteErr(false);
    setEarningsErr(false);
    setDividendsErr(false);
    setTechErr(false);
    setError("");

    // 1) Quote
    try {
      const q = await fetchQuote(ticker);
      setQuote(q);
    } catch {
      setQuoteErr(true);
      setQuote(null);
    }

    // 2) Earnings
    try {
      const e = await fetchEarnings(ticker);
      setEarnings(e);
    } catch {
      setEarningsErr(true);
      setEarnings(null);
    }

    // 3) Dividends
    try {
      const d = await fetchDividends(ticker);
      setDividends(d);
    } catch {
      setDividendsErr(true);
      setDividends(null);
    }

    // 4) Market
    try {
      const m = await fetchMarket();
      setMarket(m);
    } catch {
      setMarket(null);
    }

    // 5) Predictions
    setLoading(true);
    try {
      const { results } = await fetchPredict({ ticker, models });
      setResults(results);
    } catch (e) {
      setError(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }

    // 6) Tech (optional; will show N/A if not available)
    try {
      // These helpers call /rsi and /correlation if you add them later.
      const [rsiMod, corrMod] = await Promise.allSettled([
        import("./techApi").then(m => m.fetchRSI(ticker)),
        import("./techApi").then(m => m.fetchCorrelation(ticker)),
      ]);
      if (rsiMod.status === "fulfilled") setRsi(rsiMod.value);
      else setRsi(null);
      if (corrMod.status === "fulfilled") setCorr(corrMod.value);
      else setCorr(null);
    } catch {
      setTechErr(true);
      setRsi(null);
      setCorr(null);
    }
  }, [ticker, models]);

  useEffect(() => {
    loadData();
    if (autoRefresh) {
      const iv = setInterval(loadData, 60_000);
      return () => clearInterval(iv);
    }
  }, [loadData, autoRefresh]);

  const handleSubmit = (e) => {
    e.preventDefault();
    loadData();
  };

  const toggleModel = (m) =>
    setModels((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    );

  // --- NEW: compute proxy metrics & recommendation on the client ---
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
      return {
        model: r.model,
        mapeProxy,        // 0.0123 -> 1.23%
        avgChangePct,     // direction/strength
      };
    });
  }, [quote, results]);

  const recommendation = useMemo(() => {
    if (!metrics.length) return null;
    // lowest proxy-MAPE wins
    const best = [...metrics].sort((a, b) => a.mapeProxy - b.mapeProxy)[0];
    let action = "Hold";
    if (best.avgChangePct > 1) action = "Buy";
    if (best.avgChangePct < -1) action = "Sell";
    return { ...best, action };
  }, [metrics]);

  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: "auto" }}>
      <h1>Real-Time Stock & Crypto Dashboard</h1>

      <form onSubmit={handleSubmit} style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="Ticker (e.g. AAPL or BTC-USD)"
          required
        />
        <button disabled={loading}>
          {loading ? "Loading…" : "Load Data"}
        </button>
      </form>

      <label style={{ display: "block", marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={() => setAutoRefresh((v) => !v)}
        />{" "}
        🔄 Auto-refresh every 60 s
      </label>

      {/* Top info row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 12 }}>
        {/* Quote Card */}
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>💰 Current Price ({ticker})</h2>
          {quoteErr ? (
            <p style={{ color: "red", margin: 0 }}>Error loading quote</p>
          ) : quote ? (
            <>
              <p style={{ margin: 0 }}>Last Close: ${quote.last_close}</p>
              <p style={{ margin: 0 }}>
                ${quote.current_price}{" "}
                {quote.change_pct >= 0 ? "🔺" : "🔻"}{" "}
                {Math.abs(quote.change_pct)}%
              </p>
            </>
          ) : (
            <p style={{ color: "#666", margin: 0 }}>N/A</p>
          )}
        </div>

        {/* Earnings & Dividends */}
        <EarningsCard earnings={earnings} />
        <DividendCard dividends={dividends} />

        {/* NEW: Recommendation */}
        <RecommendationCard recommendation={recommendation} />
      </div>

      {/* Market Breadth */}
      {market && <MarketCard market={market} />}

      {/* NEW: Metrics list (proxy MAPE per model) */}
      {!!metrics.length && (
        <MetricsList metrics={metrics} />
      )}

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

      {/* NEW: Tech section (scaffold) */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 16 }}>
        <RSIChart rsi={rsi} />
        <CorrelationChart corr={corr} />
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
