import { useCallback, useEffect, useRef, useState } from "react";
import { fetchQuote, fetchPredict, fetchCloses, fetchStats } from "../api";
import useLocalStorage from "../hooks/useLocalStorage";

const MAX_TICKERS = 3;
const SAVE_KEY = "COMPARE_LAST_V1";

export default function CompareMode({ defaultModels = ["LSTM", "ARIMA"], onExit }) {
  const [watchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [selected, setSelected] = useState([]);
  const [input, setInput] = useState("");
  const [models, setModels] = useState(defaultModels);
  const [rows, setRows] = useState([]); // {symbol, quote, results, closes, stats, metrics, recommendation, error, isWinner}
  const [winnerStrategy, setWinnerStrategy] = useState("long"); // "long" | "short"

  // request versioning to avoid race conditions
  const reqVerRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // restore last session
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
      if (saved && Array.isArray(saved.tickers)) {
        setSelected(saved.tickers.slice(0, MAX_TICKERS));
        if (saved.strategy === "short" || saved.strategy === "long") {
          setWinnerStrategy(saved.strategy);
        }
      }
    } catch {}
  }, []);

  // persist session
  useEffect(() => {
    const payload = { tickers: selected, strategy: winnerStrategy };
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  }, [selected, winnerStrategy]);

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

  const loadFromWatchlist = () => {
    const picks = (watchlist || []).map((w) => w.symbol).slice(0, MAX_TICKERS);
    setSelected(picks);
  };

  /** Clean/validate closes array */
  const normalizeCloses = (arr) => {
    if (!Array.isArray(arr)) return [];
    const cleaned = arr
      .map(Number)
      .filter((v) => Number.isFinite(v));
    // need 2+ points for a line
    return cleaned.length >= 2 ? cleaned : [];
  };

  /** Attempt 2: fallback closes fetch (without days param) */
  const fetchClosesSafe = async (ticker) => {
    try {
      const a = await fetchCloses(ticker, 7);
      let c = normalizeCloses(a?.closes);
      if (c.length >= 2) return c;
      // retry looser
      const b = await fetchCloses(ticker); // backend default window
      c = normalizeCloses(b?.closes);
      return c;
    } catch (e) {
      console.warn("[closes] failed for", ticker, e);
      return [];
    }
  };

  const load = useCallback(async () => {
    const myVer = ++reqVerRef.current;

    if (!selected.length) {
      if (mountedRef.current && reqVerRef.current === myVer) setRows([]);
      return;
    }

    const tasks = selected.map(async (symbol) => {
      const t = symbol.toUpperCase();
      try {
        const [q, pred, c7, stat] = await Promise.all([
          fetchQuote(t),
          fetchPredict({ ticker: t, models }),
          fetchClosesSafe(t),
          fetchStats(t).catch(() => null),
        ]);

        const results = pred?.results || [];
        const quote = q || null;
        const closes = c7 || [];
        const stats = stat || null;

        // metrics + recommendation
        let metrics = [];
        if (quote && results.length) {
          const base = Number(quote.last_close) || 0;
          if (base > 0) {
            metrics = results.map((r) => {
              const mapeProxy =
                r.predictions.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) /
                r.predictions.length;
              const meanPred =
                r.predictions.reduce((a, b) => a + b, 0) / r.predictions.length;
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

        return { symbol: t, quote, results, closes, stats, metrics, recommendation, error: null };
      } catch (e) {
        return {
          symbol: t,
          quote: null,
          results: [],
          closes: [],
          stats: null,
          metrics: [],
          recommendation: null,
          error: e?.message || "Fetch error",
        };
      }
    });

    const out = await Promise.all(tasks);
    if (!mountedRef.current || reqVerRef.current !== myVer) return;

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
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>🆚 Compare Tickers (up to {MAX_TICKERS})</h2>
        <div className="row">
          <button className="btn" onClick={loadFromWatchlist} disabled={!watchlist?.length}>
            Load from Watchlist
          </button>
          <label className="row" style={{ marginLeft: 8 }}>
            Strategy:
            <select
              value={winnerStrategy}
              onChange={(e) => setWinnerStrategy(e.target.value)}
              style={{ marginLeft: 6 }}
            >
              <option value="long">Long (Buy &gt; Hold &gt; Sell)</option>
              <option value="short">Short (Sell &gt; Hold &gt; Buy)</option>
            </select>
          </label>
          <button className="btn ghost" onClick={onExit} style={{ marginLeft: 8 }}>Close</button>
        </div>
      </div>

      <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 280, flex: "1 1 320px" }}>
          <h4 style={{ margin: "0 0 6px" }}>From Watchlist</h4>
          <div style={{ maxHeight: 160, overflow: "auto", border: "1px solid var(--border)", borderRadius: 10, padding: 8 }}>
            {watchlist.length === 0 && <div className="muted">Your watchlist is empty.</div>}
            {watchlist.map(({ symbol, tag }) => {
              const active = selected.includes(symbol);
              return (
                <label key={symbol} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => togglePick(symbol)}
                    disabled={!active && selected.length >= MAX_TICKERS}
                  />
                  <span style={{ minWidth: 70, display: "inline-block" }}>{symbol}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{tag}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div style={{ minWidth: 280, flex: "1 1 320px" }}>
          <h4 style={{ margin: "0 0 6px" }}>Add Manually</h4>
          <div className="row" style={{ gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              placeholder="e.g. MSFT"
              onKeyDown={(e) => e.key === "Enter" && addFromInput()}
            />
            <button className="btn" onClick={addFromInput} disabled={selected.length >= MAX_TICKERS}>Add</button>
            <button className="btn ghost" onClick={clearAll} disabled={selected.length === 0}>Clear</button>
          </div>

          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            Selected: {selected.join(", ") || "—"}
          </div>

          <h4 style={{ margin: "12px 0 6px" }}>Models</h4>
          <ModelPicker models={models} setModels={setModels} />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: 16,
          marginTop: 12,
        }}
      >
        {rows.map((r) => (
          <CompareColumn key={r.symbol} row={r} />
        ))}
        {!rows.length && <p className="muted">Choose up to 3 tickers to compare.</p>}
      </div>
    </div>
  );
}

function ModelPicker({ models, setModels }) {
  const OPTIONS = ["LSTM", "ARIMA", "RandomForest", "XGBoost"];
  const toggle = (m) =>
    setModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  return (
    <div className="row" style={{ gap: 12 }}>
      {OPTIONS.map((m) => (
        <label key={m}>
          <input type="checkbox" checked={models.includes(m)} onChange={() => toggle(m)} /> {m}
        </label>
      ))}
    </div>
  );
}

function CompareColumn({ row }) {
  const { symbol, quote, results, closes, stats, recommendation, error, isWinner } = row;

  const prevPriceRef = useRef(null);
  const [blinkClass, setBlinkClass] = useState("");
  const tweenedChange = useTweenNumber(quote?.change_pct ?? 0, { duration: 450 });

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
    <div className="card" style={{ position: "relative" }}>
      <div className="row" style={{ alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>{symbol}</h3>
        {isWinner && <span className="badge" style={{ marginLeft: 8 }}>🏆 Winner</span>}
      </div>

      {error && <p style={{ color: "salmon" }}>Error: {error}</p>}

      <section className="card" style={{ marginTop: 8 }}>
        <h4 style={{ margin: "0 0 6px" }}>Price</h4>
        {quote ? (
          <>
            <div>Last Close: ${Number(quote.last_close).toFixed(2)}</div>
            <div style={{ marginTop: 4 }} className={blinkClass}>
              Now: <strong>${Number(quote.current_price).toFixed(2)}</strong>{" "}
              {tweenedChange >= 0 ? "🔺" : "🔻"} {Math.abs(Number(tweenedChange)).toFixed(2)}%
            </div>
            <div style={{ marginTop: 8 }}>
              <Sparkline data={closes || []} width={180} height={44} />
            </div>
          </>
        ) : (
          <div className="muted">N/A</div>
        )}
      </section>

      <section className="card" style={{ marginTop: 8 }}>
        <h4 style={{ margin: "0 0 6px" }}>Quick Stats</h4>
        {stats ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, color: "#cbd5ff" }}>
            <li className="kv"><span>52w High</span><span>{stats.high_52w != null ? `$${Number(stats.high_52w).toFixed(2)}` : "—"}</span></li>
            <li className="kv"><span>52w Low</span><span>{stats.low_52w != null ? `$${Number(stats.low_52w).toFixed(2)}` : "—"}</span></li>
            <li className="kv"><span>Market Cap</span><span>{stats.market_cap ? stats.market_cap : "—"}</span></li>
            <li className="kv"><span>Sector</span><span>{stats.sector ? stats.sector : "—"}</span></li>
          </ul>
        ) : (
          <div className="muted">N/A</div>
        )}
      </section>

      <section className="card" style={{ marginTop: 8 }}>
        <h4 style={{ margin: "0 0 6px" }}>Recommendation</h4>
        {recommendation ? (
          <>
            <div>
              Based on lowest proxy-MAPE: <strong>{recommendation.model}</strong>
            </div>
            <div style={{ fontSize: 18 }}>
              <strong>{recommendation.action}</strong>{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                (avg change {Number(recommendation.avgChangePct).toFixed(2)}%)
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Proxy-MAPE = average |pred − last_close| / last_close
            </div>
          </>
        ) : (
          <div className="muted">N/A</div>
        )}
      </section>

      {results?.length > 0 && (
        <section className="table-card" style={{ marginTop: 8 }}>
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
                    {predictions.map((v, i) => (
                      <td key={i}>{Number(v).toFixed(2)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

/** tween a number (ease-out) */
function useTweenNumber(target = 0, { duration = 450 } = {}) {
  const [val, setVal] = useState(Number(target) || 0);
  const rafRef = useRef(0);
  const tStartRef = useRef(0);
  const prevRef = useRef(Number(target) || 0);

  useEffect(() => {
    const from = prevRef.current;
    const to = Number(target) || 0;
    tStartRef.current = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - tStartRef.current) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      setVal(from + (to - from) * e);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else prevRef.current = to;
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return val;
}

/** Tiny sparkline with native <title> tooltips + morph animation */
function Sparkline({ data = [], width = 180, height = 44, strokeWidth = 2, duration = 450 }) {
  const pad = 6;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const prevDataRef = useRef([]);
  const [animPts, setAnimPts] = useState([]);

  const computePoints = (arr) => {
    if (!Array.isArray(arr) || arr.length < 2) return [];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const range = max - min || 1;
    return arr.map((v, i) => {
      const x = pad + (i * w) / (arr.length - 1);
      const y = pad + h - ((v - min) / range) * h;
      return { x, y, v, i };
    });
  };

  useEffect(() => {
    if (!Array.isArray(data) || data.length < 2) {
      setAnimPts([]);
      prevDataRef.current = data.slice();
      return;
    }
    const toPts = computePoints(data);
    const fromPts = computePoints(prevDataRef.current.length === data.length ? prevDataRef.current : data);
    const start = performance.now();
    let raf = 0;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      const mixed = toPts.map((to, i) => {
        const fr = fromPts[i] || to;
        return {
          x: fr.x + (to.x - fr.x) * e,
          y: fr.y + (to.y - fr.y) * e,
          v: data[i],
          i,
        };
      });
      setAnimPts(mixed);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    prevDataRef.current = data.slice();
    return () => cancelAnimationFrame(raf);
  }, [JSON.stringify(data), duration]);

  if (!Array.isArray(data) || data.length < 2) {
    return <div className="muted" style={{ fontSize: 12 }}>no data</div>;
  }

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
      {animPts.map(({ x, y, v, i }) => (
        <circle key={i} cx={x} cy={y} r="2.5" fill="#a8b2ff">
          <title>{`t-${animPts.length - 1 - i} • $${v.toFixed(2)}`}</title>
        </circle>
      ))}
    </svg>
  );
}
