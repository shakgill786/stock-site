import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchQuote, fetchPredict, fetchCloses } from "../api";
import useLocalStorage from "../hooks/useLocalStorage";

const MAX_TICKERS = 3;

export default function CompareMode({ defaultModels = ["LSTM", "ARIMA"], onExit }) {
  const [watchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [selected, setSelected] = useState([]);
  const [input, setInput] = useState("");
  const [models, setModels] = useState(defaultModels);
  const [rows, setRows] = useState([]); // {symbol, quote, results, closes, metrics, recommendation, error}
  const [winnerStrategy, setWinnerStrategy] = useState("long"); // "long" | "short"

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

  const load = useCallback(async () => {
    if (!selected.length) {
      setRows([]);
      return;
    }
    // fetch each symbol in parallel (quote, predictions, closes)
    const tasks = selected.map(async (symbol) => {
      const t = symbol.toUpperCase();
      try {
        const [q, pred, hist] = await Promise.all([
          fetchQuote(t),
          fetchPredict({ ticker: t, models }),
          fetchCloses(t, 7),
        ]);
        const results = pred.results || [];
        const quote = q || null;
        const closes = hist?.closes || [];

        // metrics + recommendation
        let metrics = [];
        if (quote && results.length) {
          const base = Number(quote.last_close) || 0;
          if (base > 0) {
            metrics = results.map((r) => {
              const mapeProxy =
                r.predictions.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) /
                r.predictions.length;
              const meanPred = r.predictions.reduce((a, b) => a + b, 0) / r.predictions.length;
              const avgChangePct = ((meanPred - base) / base) * 100;
              return { model: r.model, mapeProxy, avgChangePct };
            });
          }
        }

        let recommendation = null;
        if (metrics.length) {
          const best = [...metrics].sort((a, b) => a.mapeProxy - b.mapeProxy)[0];
          let action = "Hold";
          if (best.avgChangePct > 1) action = "Buy";
          if (best.avgChangePct < -1) action = "Sell";
          recommendation = { ...best, action };
        }

        return { symbol: t, quote, results, closes, metrics, recommendation, error: null };
      } catch (e) {
        return { symbol: t, quote: null, results: [], closes: [], metrics: [], recommendation: null, error: e.message || "Fetch error" };
      }
    });

    const out = await Promise.all(tasks);

    // winner logic (strategy aware)
    const scoreMap =
      winnerStrategy === "short"
        ? { Sell: 2, Hold: 1, Buy: 0 }
        : { Buy: 2, Hold: 1, Sell: 0 };

    const scored = out.map((r, idx) => {
      const rec = r.recommendation;
      if (!rec) return { idx, score: -1, magnitude: 0 };
      const baseScore = scoreMap[rec.action] ?? -1;
      const magnitude = Math.abs(rec.avgChangePct || 0);
      return { idx, score: baseScore, magnitude };
    });

    const winner = scored
      .filter((s) => s.score >= 0)
      .sort((a, b) => (b.score - a.score) || (b.magnitude - a.magnitude))[0];

    const withWinner = out.map((r, idx) => ({ ...r, isWinner: winner ? idx === winner.idx : false }));
    setRows(withWinner);
  }, [selected, models, winnerStrategy]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={wrap}>
      <div style={topbar}>
        <h2 style={{ margin: 0 }}>🆚 Compare Tickers (up to {MAX_TICKERS})</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Strategy toggle */}
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Strategy:
            <select value={winnerStrategy} onChange={(e) => setWinnerStrategy(e.target.value)}>
              <option value="long">Long (Buy &gt; Hold &gt; Sell)</option>
              <option value="short">Short (Sell &gt; Hold &gt; Buy)</option>
            </select>
          </label>
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

      <div style={grid}>
        {rows.map((r) => (
          <CompareColumn key={r.symbol} row={r} />
        ))}
        {!rows.length && <p style={{ color: "#666" }}>Choose up to 3 tickers to compare.</p>}
      </div>
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

function CompareColumn({ row }) {
  const { symbol, quote, results, closes, recommendation, error, isWinner } = row;

  // price blink on update
  const prevPriceRef = useRef(null);
  const [blinkClass, setBlinkClass] = useState("");

  useEffect(() => {
    const next = Number(quote?.current_price);
    const prev = prevPriceRef.current;
    if (typeof next === "number" && !Number.isNaN(next) && typeof prev === "number" && !Number.isNaN(prev) && prev !== next) {
      setBlinkClass(next > prev ? "blink-up" : "blink-down");
      const t = setTimeout(() => setBlinkClass(""), 520);
      return () => clearTimeout(t);
    }
    prevPriceRef.current = next;
  }, [quote?.current_price]);

  return (
    <div style={col}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>{symbol}</h3>
        {isWinner && <span style={badge}>🏆 Winner</span>}
      </div>

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      <section style={card}>
        <h4 style={{ margin: "0 0 6px" }}>Price</h4>
        {quote ? (
          <>
            <div>Last Close: ${Number(quote.last_close).toFixed(2)}</div>
            <div style={{ marginTop: 4 }} className={blinkClass}>
              Now: <strong>${Number(quote.current_price).toFixed(2)}</strong>{" "}
              {quote.change_pct >= 0 ? "🔺" : "🔻"} {Math.abs(Number(quote.change_pct)).toFixed(2)}%
            </div>
            <div style={{ marginTop: 8 }}>
              <Sparkline data={closes || []} width={140} height={36} />
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
                (avg change {Number(recommendation.avgChangePct).toFixed(2)}%)
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

/**
 * Tiny SVG sparkline with:
 *  - native tooltips on each point (t-6 … t-0)
 *  - smooth morph animation when data changes
 */
function Sparkline({ data = [], width = 140, height = 36, strokeWidth = 2, duration = 450 }) {
  const pad = 4;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const prevDataRef = useRef([]);
  const [animPts, setAnimPts] = useState([]);

  // prepare points for a given dataset
  const computePoints = (arr) => {
    if (!Array.isArray(arr) || arr.length < 2) return [];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const range = max - min || 1;
    return arr.map((v, i) => {
      const x = pad + (i * w) / (arr.length - 1);
      const y = pad + h - ((v - min) / range) * h;
      return { x, y, v, i, min, max };
    });
  };

  const [targetPts, targetLabels] = useMemo(() => {
    const pts = computePoints(data);
    const labels = data.map((_, i, arr) => `t-${arr.length - 1 - i}`);
    return [pts, labels];
  }, [data]);

  // run animation from prev -> target
  useEffect(() => {
    if (!targetPts.length) {
      setAnimPts([]);
      prevDataRef.current = data;
      return;
    }

    const fromArr = prevDataRef.current?.length === data.length ? prevDataRef.current : data; // fallback
    const fromPts = computePoints(fromArr.length === data.length ? fromArr : data);

    const start = performance.now();
    let raf = 0;

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const e = 1 - Math.pow(1 - t, 3);
      const mixed = targetPts.map((to, i) => {
        const fr = fromPts[i] || to;
        return {
          x: fr.x + (to.x - fr.x) * e,
          y: fr.y + (to.y - fr.y) * e,
          v: data[i],
          i,
        };
      });
      setAnimPts(mixed);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      }
    };

    raf = requestAnimationFrame(tick);
    prevDataRef.current = data;

    return () => cancelAnimationFrame(raf);
  }, [data, targetPts, duration]);

  if (!animPts.length) return <div style={{ color: "#999", fontSize: 12 }}>no data</div>;

  const pointsAttr = animPts.map(({ x, y }) => `${x},${y}`).join(" ");
  const lastUp = data[data.length - 1] >= data[0];

  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const lastVal = data[data.length - 1];

  return (
    <svg width={width} height={height}>
      <polyline
        fill="none"
        stroke={lastUp ? "#2e7d32" : "#c62828"}
        strokeWidth={strokeWidth}
        points={pointsAttr}
      >
        <title>
          Sparkline: min ${minVal.toFixed(2)}, max ${maxVal.toFixed(2)}, last ${lastVal.toFixed(2)}
        </title>
      </polyline>

      {/* points with tooltips */}
      {animPts.map(({ x, y, v, i }) => (
        <circle key={i} cx={x} cy={y} r="2.5" fill="#666">
          <title>{`t-${animPts.length - 1 - i} • $${v.toFixed(2)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

const wrap = { border: "1px solid #ddd", borderRadius: 8, padding: 12, marginTop: 12 };
const topbar = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 };
const pickerRow = { display: "flex", gap: 16, flexWrap: "wrap" };
const pickerCol = { minWidth: 280, flex: "1 1 320px" };
const wlRow = { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" };
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginTop: 12 };
const col = { border: "1px solid #eee", borderRadius: 8, padding: 12, position: "relative" };
const card = { border: "1px solid #eee", borderRadius: 8, padding: 10, marginTop: 8 };
const tbl = { width: "100%", borderCollapse: "collapse" };
const th = { borderBottom: "1px solid #eee", textAlign: "left", padding: "4px 6px", fontSize: 12 };
const td = { borderBottom: "1px solid #f6f6f6", padding: "4px 6px", fontSize: 12 };
const badge = {
  background: "gold",
  color: "#333",
  padding: "2px 6px",
  borderRadius: 999,
  fontSize: 12,
  border: "1px solid #d1b300",
};
