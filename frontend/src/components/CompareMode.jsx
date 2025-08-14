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
  const [rows, setRows] = useState([]); // {symbol, quote, results, closes, dates, stats, metrics, recommendation, error, isWinner}
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
    const cleaned = arr.map(Number).filter((v) => Number.isFinite(v));
    return cleaned.length >= 2 ? cleaned : [];
  };

  /** Pull ~5 years if available; include dates for tooltips */
  const fetchClosesSafe = async (ticker) => {
    try {
      const a = await fetchCloses(ticker, 1825); // ~5 years
      let c = normalizeCloses(a?.closes);
      if (c.length >= 2) return { dates: Array.isArray(a?.dates) ? a.dates : [], closes: c };

      // retry looser (backend default)
      const b = await fetchCloses(ticker);
      c = normalizeCloses(b?.closes);
      return { dates: Array.isArray(b?.dates) ? b.dates : [], closes: c };
    } catch (e) {
      console.warn("[closes] failed for", ticker, e);
      return { dates: [], closes: [] };
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
        const closes = c7?.closes || [];
        const dates = c7?.dates || [];
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

        return { symbol: t, quote, results, closes, dates, stats, metrics, recommendation, error: null };
      } catch (e) {
        return {
          symbol: t,
          quote: null,
          results: [],
          closes: [],
          dates: [],
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
  const { symbol, quote, results, closes, dates, stats, recommendation, error, isWinner } = row;

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

  const [showBig, setShowBig] = useState(false);

  return (
    <div className="card" style={{ position: "relative" }}>
      <div className="row" style={{ alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>{symbol}</h3>
        {isWinner && <span className="badge" style={{ marginLeft: 8 }}>🏆 Winner</span>}
      </div>

      {error && <p style={{ color: "salmon" }}>Error: {error}</p>}

      <section className="card" style={{ marginTop: 8 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h4 style={{ margin: "0 0 6px" }}>Price</h4>
          <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => setShowBig(true)}>
            🔍 Magnify
          </button>
        </div>
        {quote ? (
          <>
            <div>Last Close: ${Number(quote.last_close).toFixed(2)}</div>
            <div style={{ marginTop: 4 }} className={blinkClass}>
              Now: <strong>${Number(quote.current_price).toFixed(2)}</strong>{" "}
              <span
                style={{
                  color: tweenedChange >= 0 ? "#2e7d32" : "#c62828",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4
                }}
              >
                {tweenedChange >= 0 ? "▲" : "▼"} {Math.abs(Number(tweenedChange)).toFixed(2)}%
              </span>
            </div>
            <div style={{ marginTop: 8 }}>
              <InteractiveChart data={closes || []} labels={dates || []} width={220} height={60} />
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
              <strong
                style={{
                  color:
                    recommendation.action === "Buy"
                    ? "#2e7d32" // green
                    : recommendation.action === "Sell"
                    ? "#c62828" // red
                    : "#9aa0a6", // grey for Hold
                }}
              >
                {recommendation.action}
              </strong>{" "}
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

      {showBig && (
        <MagnifyModal title={`${symbol} • Price`} onClose={() => setShowBig(false)}>
          <InteractiveChart data={closes || []} labels={dates || []} width={800} height={300} big />
        </MagnifyModal>
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

/** Interactive SVG line chart with hover scrub, drag-pan, wheel-zoom + date labels */
function InteractiveChart({ data = [], labels = [], width = 220, height = 60, big = false }) {
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

  // clamp helpers
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const vStart = clamp(view.start, 0, data.length - 2);
  const vEnd = clamp(view.end, vStart + 1, data.length - 1);
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

  const points = windowData
    .map((v, k) => {
      const i = vStart + k;
      return `${xForIndex(i)},${yForVal(v)}`;
    })
    .join(" ");

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
      // clamp range
      if (newStart < 0) {
        newStart = 0;
        newEnd = windowSize;
      }
      if (newEnd > data.length - 1) {
        newEnd = data.length - 1;
        newStart = newEnd - windowSize;
      }
      setView({ start: newStart, end: newEnd });
    }
  };

  const onLeave = () => {
    setCursorX(null);
    setHoverIdx(null);
    setDrag(null);
  };

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
    const delta = Math.sign(e.deltaY); // 1 = zoom out, -1 = zoom in
    const zoomStep = Math.max(1, Math.round(windowSize * 0.15));
    let newSize = delta < 0 ? windowSize - zoomStep : windowSize + zoomStep;
    newSize = clamp(newSize, 5, data.length - 1);

    let newStart = focusIdx - Math.round((focusIdx - vStart) * (newSize / windowSize));
    let newEnd = newStart + newSize;

    if (newStart < 0) {
      newStart = 0;
      newEnd = newSize;
    }
    if (newEnd > data.length - 1) {
      newEnd = data.length - 1;
      newStart = newEnd - newSize;
    }

    setView({ start: newStart, end: newEnd });
  };

  const onDblClick = () => setView({ start: 0, end: data.length - 1 });

  const showIdx = clamp(hoverIdx ?? vEnd, 0, data.length - 1);
  const showVal = data[showIdx];
  const showX = xForIndex(showIdx);
  const showY = yForVal(showVal);

  // Hover label prefers real date when labels align
  let hoverLabel;
  if (Array.isArray(labels) && labels.length === data.length) {
    const d = labels[showIdx];
    try {
      const dt = new Date(d);
      hoverLabel = dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      hoverLabel = String(d);
    }
  } else {
    const rel = data.length - 1 - showIdx; // 0 = latest
    hoverLabel = rel === 0 ? "latest" : `t-${rel}d`;
  }

  // tooltip width depends on label length
  const textW = Math.min(180, 70 + String(hoverLabel).length * 6);
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
      {/* background */}
      <rect x="0" y="0" width={width} height={height} rx="8" ry="8" fill="rgba(255,255,255,0.03)" />

      {/* polyline */}
      <polyline
        fill="none"
        stroke={lastUp ? "#2e7d32" : "#c62828"}
        strokeWidth={big ? 2.5 : 2}
        points={points}
      />

      {/* cursor + crosshair */}
      {cursorX != null && (
        <>
          <line x1={showX} x2={showX} y1={pad} y2={pad + h} stroke="#a8b2ff" strokeDasharray="3,3" />
          <circle cx={showX} cy={showY} r={big ? 4 : 3} fill="#a8b2ff" />
          {/* tooltip bubble */}
          <g>
            <rect
              x={boxX}
              y={boxY}
              width={textW}
              height="22"
              rx="6"
              fill="rgba(0,0,0,0.65)"
              stroke="rgba(255,255,255,0.25)"
            />
            <text x={boxX + 10} y={boxY + 15} fontSize={big ? 12 : 11} fill="#fff">
              ${Number(showVal).toFixed(2)} • {hoverLabel}
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
        padding: 16
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
