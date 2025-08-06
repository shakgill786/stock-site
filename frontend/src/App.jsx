// frontend/src/App.jsx

import { useState, useEffect, useCallback } from "react";
import {
  fetchPredict,
  fetchQuote,
  fetchEarnings
} from "./api";
import "./App.css";

const MODEL_OPTIONS = ["LSTM", "ARIMA", "RandomForest", "XGBoost"];

export default function App() {
  const [ticker, setTicker] = useState("AAPL");
  const [models, setModels] = useState(["LSTM", "ARIMA"]);
  const [quote, setQuote] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadData = useCallback(async () => {
    setError("");
    // 1) Quote
    try {
      const q = await fetchQuote(ticker);
      setQuote(q);
    } catch {
      setQuote(null);
    }
    // 2) Earnings
    try {
      const e = await fetchEarnings(ticker);
      setEarnings(e);
    } catch {
      setEarnings(null);
    }
    // 3) Predictions
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

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: "auto" }}>
      <h1>Real-Time Stock & Crypto Dashboard</h1>

      <form onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="Ticker (e.g. AAPL or BTC-USD)"
          required
        />
        <button disabled={loading} style={{ marginLeft: 8 }}>
          {loading ? "Loading..." : "Load Data"}
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

      {quote && (
        <div style={cardStyle}>
          <h2>💰 Current Price for {quote.ticker}</h2>
          <p>Last Close: ${quote.last_close}</p>
          <p>
            ${quote.current_price}{" "}
            {quote.change_pct >= 0 ? "🔺" : "🔻"} {Math.abs(quote.change_pct)}%
          </p>
        </div>
      )}

      {earnings && (
        <div style={cardStyle}>
          <h2>🗓️ Next Earnings Date</h2>
          <p>{earnings.nextEarningsDate}</p>
        </div>
      )}

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      {results.length > 0 && (
        <>
          {/* Forecast table */}
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
        </>
      )}
    </div>
  );
}

const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
  maxWidth: 300,
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
