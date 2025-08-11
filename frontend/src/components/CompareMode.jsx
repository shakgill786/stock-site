import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchQuote, fetchPredict } from "../api";
import useLocalStorage from "../hooks/useLocalStorage";

const MAX_TICKERS = 3;

export default function CompareMode({ defaultModels = ["LSTM", "ARIMA"], onExit }) {
  const [watchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [selected, setSelected] = useState([]); // array of symbols
  const [input, setInput] = useState("");
  const [models, setModels] = useState(defaultModels);

  const addFromInput = () => {
    const s = input.trim().toUpperCase();
    if (!s) return;
    if (!selected.includes(s) && selected.length < MAX_TICKERS) {
      setSelected((prev) => [...prev, s]);
    }
    setInput("");
  };

  const togglePick = (s) => {
    if (selected.includes(s)) {
      setSelected(selected.filter((x) => x !== s));
    } else if (selected.length < MAX_TICKERS) {
      setSelected([...selected, s]);
    }
  };

  const clearAll = () => setSelected([]);

  return (
    <div style={wrap}>
      <div style={topbar}>
        <h2 style={{ margin: 0 }}>🆚 Compare Tickers (up to {MAX_TICKERS})</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onExit}>Close</button>
        </div>
      </div>

      <div style={pickerRow}>
        <div style={pickerCol}>
          <h4 style={{ margin: "0 0 6px" }}>From Watchlist</h4>
          <div style={{ maxHeight: 160, overflow: "auto", border: "1px solid #eee", borderRadius: 6, padding: 8 }}>
            {watchlist.length === 0 && <div style={{ color: "#666" }}>Your watchlist is empty.</div>}
            {watchlist.map(({ symbol, tag }) => {
              const active = selected.includes(symbol);
              return (
                <label key={symbol} style={wlRow}>
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => togglePick(symbol)}
                    disabled={!active && selected.length >= MAX_TICKERS}
                  />
                  <span style={{ minWidth: 70, display: "inline-block" }}>{symbol}</span>
                  <span style={{ color: "#666", fontSize: 12 }}>{tag}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div style={pickerCol}>
          <h4 style={{ margin: "0 0 6px" }}>Add Manually</h4>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              placeholder="e.g. MSFT"
              onKeyDown={(e) => e.key === "Enter" && addFromInput()}
            />
            <button onClick={addFromInput} disabled={selected.length >= MAX_TICKERS}>Add</button>
            <button onClick={clearAll} disabled={selected.length === 0}>Clear</button>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
            Selected: {selected.join(", ") || "—"}
          </div>

          <h4 style={{ margin: "12px 0 6px" }}>Models</h4>
          <ModelPicker models={models} setModels={setModels} />
        </div>
      </div>

      <CompareResults selected={selected} models={models} />
    </div>
  );
}

function ModelPicker({ models, setModels }) {
  const OPTIONS = ["LSTM", "ARIMA", "RandomForest", "XGBoost"];
  const toggle = (m) =>
    setModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  return (
    <div>
      {OPTIONS.map((m) => (
        <label key={m} style={{ marginRight: 12 }}>
          <input type="checkbox" checked={models.includes(m)} onChange={() => toggle(m)} /> {m}
        </label>
      ))}
    </div>
  );
}

function CompareResults({ selected, models }) {
  const [rows, setRows] = useState([]); // {symbol, quote, results, error}

  const load = useCallback(async () => {
    if (!selected.length) {
      setRows([]);
      return;
    }
    // fetch each symbol in parallel
    const tasks = selected.map(async (symbol) => {
      const t = symbol.toUpperCase();
      try {
        const [q, pred] = await Promise.all([fetchQuote(t), fetchPredict({ ticker: t, models })]);
        return { symbol: t, quote: q, results: pred.results, error: null };
      } catch (e) {
        return { symbol: t, quote: null, results: [], error: e.message || "Fetch error" };
      }
    });
    const out = await Promise.all(tasks);
    setRows(out);
  }, [selected, models]);

  useEffect(() => {
    load();
  }, [load]);

  if (!selected.length) {
    return <p style={{ color: "#666" }}>Choose up to 3 tickers to compare.</p>;
  }

  return (
    <div style={grid}>
      {rows.map((r) => (
        <CompareColumn key={r.symbol} row={r} />
      ))}
    </div>
  );
}

function CompareColumn({ row }) {
  const { symbol, quote, results, error } = row;

  const metrics = useMemo(() => {
    if (!quote || !results?.length) return [];
    const base = Number(quote.last_close) || 0;
    if (!base) return [];
    return results.map((r) => {
      const mapeProxy =
        r.predictions.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) / r.predictions.length;
      const meanPred = r.predictions.reduce((a, b) => a + b, 0) / r.predictions.length;
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
    <div style={col}>
      <h3 style={{ marginTop: 0 }}>{symbol}</h3>

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      <section style={card}>
        <h4 style={{ margin: "0 0 6px" }}>Price</h4>
        {quote ? (
          <>
            <div>Last Close: ${Number(quote.last_close).toFixed(2)}</div>
            <div style={{ marginTop: 4 }}>
              Now: <strong>${Number(quote.current_price).toFixed(2)}</strong>{" "}
              {quote.change_pct >= 0 ? "🔺" : "🔻"} {Math.abs(Number(quote.change_pct)).toFixed(2)}%
            </div>
          </>
        ) : (
          <div style={{ color: "#666" }}>N/A</div>
        )}
      </section>

      <section style={card}>
        <h4 style={{ margin: "0 0 6px" }}>Recommendation</h4>
        {recommendation ? (
          <>
            <div>
              Based on lowest proxy-MAPE: <strong>{recommendation.model}</strong>
            </div>
            <div style={{ fontSize: 18 }}>
              <strong>{recommendation.action}</strong>{" "}
              <span style={{ color: "#666", fontSize: 12 }}>
                (avg change {recommendation.avgChangePct.toFixed(2)}%)
              </span>
            </div>
            <div style={{ color: "#666", fontSize: 12 }}>
              Proxy-MAPE = average |pred − last_close| / last_close
            </div>
          </>
        ) : (
          <div style={{ color: "#666" }}>N/A</div>
        )}
      </section>

      {results?.length > 0 && (
        <section style={card}>
          <h4 style={{ margin: "0 0 6px" }}>Forecasts (next 7d)</h4>
          <table style={tbl}>
            <thead>
              <tr>
                <th style={th}>Model</th>
                {results[0].predictions.map((_, i) => (
                  <th key={i} style={th}>{`+${i + 1}d`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map(({ model, predictions }) => (
                <tr key={model}>
                  <td style={td}>{model}</td>
                  {predictions.map((v, i) => (
                    <td key={i} style={td}>{Number(v).toFixed(2)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const wrap = { border: "1px solid #ddd", borderRadius: 8, padding: 12, marginTop: 12 };
const topbar = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 };
const pickerRow = { display: "flex", gap: 16, flexWrap: "wrap" };
const pickerCol = { minWidth: 280, flex: "1 1 320px" };
const wlRow = { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" };
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginTop: 12 };
const col = { border: "1px solid #eee", borderRadius: 8, padding: 12 };
const card = { border: "1px solid #eee", borderRadius: 8, padding: 10, marginTop: 8 };
const tbl = { width: "100%", borderCollapse: "collapse" };
const th = { borderBottom: "1px solid #eee", textAlign: "left", padding: "4px 6px", fontSize: 12 };
const td = { borderBottom: "1px solid #f6f6f6", padding: "4px 6px", fontSize: 12 };
