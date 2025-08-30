import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchPredict,
  fetchQuote,
  fetchEarnings,
  fetchMarket,
  fetchCloses,
  fetchPredictHistory,
} from "./api";
import MarketCard from "./components/MarketCard";
import EarningsCard from "./components/EarningsCard";
import RecommendationCard from "./components/RecommendationCard";
import MetricsList from "./components/MetricsList";
import WatchlistPanel from "./components/WatchlistPanel";
import useEventSource from "./hooks/useEventSource";
import useTweenNumber from "./hooks/useTweenNumber";
import CompareMode from "./components/CompareMode";
import HotAndEarnings from "./components/HotAndEarnings";
import "./App.css";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Chart } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  Title,
  Tooltip,
  Legend
);

const MODEL_OPTIONS = ["LSTM", "ARIMA", "RandomForest", "XGBoost"];
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://127.0.0.1:8000";

// ----- Date helpers (timezone-safe) -----
const asLocalDate = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00`);
const fmtLocalISO = (dt) => {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
const addBusinessDays = (start, n) => {
  const dt = start instanceof Date ? new Date(start) : asLocalDate(start);
  let added = 0;
  while (added < n) {
    dt.setDate(dt.getDate() + 1);
    const day = dt.getDay(); // 0=Sun,6=Sat
    if (day !== 0 && day !== 6) added++;
  }
  return dt;
};

// normalize model keys
const normModel = (s) => String(s || "").trim().toUpperCase();
const dkey = (s) => String(s).slice(0, 10);

export default function App() {
  const [ticker, setTicker] = useState("AAPL");
  const [models, setModels] = useState(["LSTM", "ARIMA"]);

  // Data states
  const [quote, setQuote] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [market, setMarket] = useState(null);

  // Errors / diagnostics
  const [quoteErr, setQuoteErr] = useState(false);
  const [earningsErr, setEarningsErr] = useState(false);
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState("");

  // Predictions
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

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

  // Retrospective history rows from backend (for past backtest lines)
  const [historyRows, setHistoryRows] = useState([]);

  // Protect against out-of-order async writes
  const reqVer = useRef(0);

  // Where to scroll when a symbol is chosen from the movers table
  const mainSectionRef = useRef(null);

  // Helpers
  const normalizeCloses = (arr) => {
    if (!Array.isArray(arr)) return [];
    const cleaned = arr.map(Number).filter((v) => Number.isFinite(v));
    return cleaned.length >= 2 ? cleaned : [];
  };

  const fetchClosesSafe = async (tkr) => {
    const tryOnce = async (days) => {
      try {
        const r = await fetchCloses(tkr, days);
        const c = normalizeCloses(r?.closes);
        const d = Array.isArray(r?.dates) ? r.dates : [];
        if (c.length >= 2 && d.length === c.length) return { dates: d, closes: c };
        return null;
      } catch {
        return null;
      }
    };
    return (
      (await tryOnce(1825)) ||
      (await tryOnce(365)) ||
      (await tryOnce(120)) ||
      (await tryOnce(60)) ||
      { dates: [], closes: [] }
    );
  };

  // Build fast lookup maps for backtests:
  const { histByDate, histPred } = useMemo(() => {
    const byDate = {};
    const byDateModel = {};
    (historyRows || []).forEach((r) => {
      const dk = dkey(r.date);
      byDate[dk] = r;
      const perModel = {};
      Object.entries(r.pred || {}).forEach(([m, v]) => {
        perModel[normModel(m)] = Number(v);
      });
      byDateModel[dk] = perModel;
    });
    return { histByDate: byDate, histPred: byDateModel };
  }, [historyRows]);

  // Prefer the API's backtest dates for the table
  const histDates = useMemo(
    () => (historyRows || []).map((r) => dkey(r.date)),
    [historyRows]
  );

  const loadData = useCallback(async () => {
    const myVer = ++reqVer.current; // this run's token

    // Reset errors (keep existing data visible during refresh)
    setError("");
    setDiagnostic("");
    setQuoteErr(false);
    setEarningsErr(false);
    setLoading(true);

    const t = String(ticker || "").toUpperCase().trim();

    // 1) Quote
    (async () => {
      try {
        const q = await fetchQuote(t);
        if (reqVer.current !== myVer) return;
        setQuote(q);
        prevPriceRef.current = q.current_price;
      } catch {
        if (reqVer.current !== myVer) return;
        setQuoteErr(true);
        setDiagnostic((d) => d || `Quote fetch failed for ${t}.`);
      }
    })();

    // 2) Earnings
    (async () => {
      try {
        const e = await fetchEarnings(t);
        if (reqVer.current !== myVer) return;
        setEarnings(e);
      } catch {
        if (reqVer.current !== myVer) return;
        setEarningsErr(true);
      }
    })();

    // 3) Market
    (async () => {
      try {
        const m = await fetchMarket();
        if (reqVer.current !== myVer) return;
        setMarket(m);
      } catch {
        /* ignore */
      }
    })();

    // 3.5) Closes for the price chart
    const pCloses = (async () => {
      try {
        const { closes: c, dates: d } = await fetchClosesSafe(t);
        if (reqVer.current !== myVer) return;
        if (!c?.length) {
          setDiagnostic((dMsg) => dMsg || `No historical price series available for ${t}.`);
        }
        setCloses(c);
        setCloseDates(d);
      } catch {
        if (reqVer.current !== myVer) return;
        setDiagnostic((dMsg) => dMsg || `Failed to load historical prices for ${t}.`);
      }
    })();

    // 4) Past backtest rows
    const pHist = (async () => {
      try {
        const hist = await fetchPredictHistory({ ticker: t, models, days: 15 });
        if (reqVer.current !== myVer) return;
        setHistoryRows(hist?.rows || []);
      } catch {
        if (reqVer.current !== myVer) return;
        setHistoryRows([]);
      }
    })();

    // 5) Current forward predictions
    const pPredict = (async () => {
      try {
        const res = await fetchPredict({ ticker: t, models });
        if (reqVer.current !== myVer) return;
        const got = Array.isArray(res?.results) ? res.results : [];
        setResults(got);
        if (!got.length) {
          const msg = res?.message || res?.detail || "No predictions returned.";
          setDiagnostic((d) => d || `${msg} (${t})`);
        }
      } catch (e) {
        if (reqVer.current !== myVer) return;
        const msg = e?.message || "Prediction fetch failed";
        setError(msg);
        setDiagnostic((d) => d || `${msg} (${t})`);
      }
    })();

    await Promise.all([pCloses, pHist, pPredict].map((p) => p?.catch?.(() => {})));

    if (reqVer.current === myVer) {
      setLoading(false);
    }
  }, [ticker, models]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Live SSE: only updates the quote card smoothly
  const streamUrl = live
    ? `${API_BASE}/quote_stream?ticker=${encodeURIComponent(ticker)}&interval=5`
    : null;

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
    setModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  // When user clicks a symbol in movers/earnings:
  const handleSelectTicker = (sym) => {
    const t = String(sym || "").toUpperCase().trim();
    if (!t) return;
    setTicker(t);
    requestAnimationFrame(() => {
      mainSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  // Client-side metrics & recommendation
  const metrics = useMemo(() => {
    if (!quote || !results?.length) return [];
    const base = Number(quote.last_close) || 0;
    if (base <= 0) return [];
    return results.map((r) => {
      const mapeProxy =
        r.predictions.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) /
        r.predictions.length;
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

  // ---------- Build a date->close map ----------
  const closeByDate = useMemo(() => {
    const m = Object.create(null);
    for (let i = 0; i < Math.min(closeDates.length, closes.length); i++) {
      const k = dkey(closeDates[i]);
      const v = Number(closes[i]);
      if (Number.isFinite(v)) m[k] = v;
    }
    return m;
  }, [closeDates, closes]);

  // ---------- Actual vs. Predicted (chart shows exactly the table window) ----------
  const horizon = results?.[0]?.predictions?.length || 0;

  // Choose the base labels for "past", preferring predict_history dates
  const pastDaysToShow = 10;
  const lastCloseISO = closeDates.length ? dkey(closeDates[closeDates.length - 1]) : null;

  const basePastLabels = useMemo(() => {
    if (histDates.length && lastCloseISO) {
      // Clip history dates to those that have a real close available
      return histDates.filter((iso) => dkey(iso) <= lastCloseISO);
    }
    return histDates.length ? histDates : closeDates;
  }, [histDates, closeDates, lastCloseISO]);

  const pastLabels = basePastLabels.slice(-pastDaysToShow);

  // future labels off the last past date (timezone-safe + skip weekends)
  const lastPastDate = pastLabels.length
    ? asLocalDate(pastLabels[pastLabels.length - 1])
    : closeDates.length
    ? asLocalDate(closeDates[closeDates.length - 1])
    : null;

  const futureLabels = Array.from({ length: horizon }, (_, i) => {
    if (!lastPastDate) return `+${i + 1}d`;
    const d = addBusinessDays(lastPastDate, i + 1);
    return fmtLocalISO(d);
  });

  // chart = past window + forecast horizon
  const chartLabels = [...pastLabels, ...futureLabels];

  // actual values aligned to the past window labels (prefer closes; fallback to historyRows.actual)
  const actualForPastLabels = pastLabels.map((iso) => {
    const k = dkey(iso);
    if (closeByDate[k] != null) return Number(closeByDate[k]);
    const v = histByDate[k]?.actual;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  });

  const colorPalette = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc949"];

  const avpDatasets = useMemo(() => {
    if (!chartLabels.length) return [];

    const actualSeries = [
      ...actualForPastLabels,
      ...Array(futureLabels.length).fill(null),
    ];

    const ds = [
      {
        label: "Actual Close",
        data: actualSeries,
        borderColor: "rgba(200,200,210,1)",
        backgroundColor: "rgba(200,200,210,0.15)",
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.2,
        spanGaps: true,
      },
    ];

    results.forEach((r, idx) => {
      const color = colorPalette[idx % colorPalette.length];
      const mKey = normModel(r.model);

      // dashed backtest for past window
      const backtestSeries = chartLabels.map((lab) => {
        const dk = dkey(lab);
        const val = histPred?.[dk]?.[mKey];
        return Number.isFinite(Number(val)) ? Number(val) : null;
      });

      ds.push({
        label: `${r.model} • backtest`,
        data: backtestSeries,
        borderColor: color,
        backgroundColor: "transparent",
        borderDash: [6, 4],
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.2,
        spanGaps: true,
      });

      // solid current forecast, anchored to last actual in past window
      const start =
        [...actualForPastLabels].reverse().find((v) => Number.isFinite(v)) ?? null;
      const currentSeries = [
        ...Array(Math.max(0, pastLabels.length - 1)).fill(null),
        start,
        ...(r.predictions || []).slice(0, futureLabels.length),
      ];

      ds.push({
        label: `${r.model} • current forecast`,
        data: currentSeries,
        borderColor: color,
        backgroundColor: "transparent",
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.2,
        spanGaps: true,
      });
    });

    return ds;
  }, [
    results,
    histPred,
    pastLabels.join("|"),
    futureLabels.join("|"),
    actualForPastLabels.join("|"),
  ]);

  const avpChartData = { labels: chartLabels, datasets: avpDatasets };
  const avpChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: "top", labels: { boxWidth: 18 } },
      title: { display: false },
      tooltip: { mode: "index", intersect: false },
    },
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } },
      y: { ticks: { callback: (v) => `$${Number(v).toFixed(0)}` } },
    },
  };

  // Table rows: last N past days (backtest) + future horizon (current predictions)
  const pastRows = pastLabels.map((iso) => {
    const dkIso = dkey(iso);
    const row = histByDate[dkIso];

    const actualFromCloses =
      closeByDate[dkIso] != null ? Number(closeByDate[dkIso]) : null;
    const actual =
      actualFromCloses != null
        ? actualFromCloses
        : Number.isFinite(Number(row?.actual))
        ? Number(row.actual)
        : null;

    const perModel = results.map((r) => {
      const v = histPred?.[dkIso]?.[normModel(r.model)];
      return Number.isFinite(Number(v)) ? Number(v) : null;
    });
    return { date: dkIso, actual, perModel, kind: "past" };
  });

  const futureRows = futureLabels.map((d, i) => {
    const perModel = results.map((r) => r.predictions?.[i] ?? null);
    return { date: d, actual: null, perModel, kind: "future" };
  });

  const avpRows = [...pastRows, ...futureRows];

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

          {/* Hot movers + Earnings this week */}
          <HotAndEarnings onSelectTicker={handleSelectTicker} />

          {/* Anchor for smooth-scroll target */}
          <div ref={mainSectionRef} />

          <form onSubmit={handleSubmit} className="row" style={{ marginBottom: 16, marginTop: 8 }}>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="Ticker (e.g. AAPL or BTC-USD)"
              required
              type="text"
              style={{ flex: "1 1 180px" }}
            />
            <button className="btn" disabled={loading}>
              {loading ? "Loading…" : "Load Data"}
            </button>
          </form>

          {/* Top info row */}
          <div className="row" style={{ gap: 16, marginBottom: 12 }}>
            {/* Quote Card */}
            <div className={`card ${blinkClass}`} style={{ minWidth: 0, flex: "1 1 300px" }}>
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
                  <p style={{ margin: "2px 0", display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontSize: "1.3em", fontWeight: 600 }}>
                      ${tweenPrice.toFixed(2)}
                    </span>
                    {Number.isFinite(Number(quote?.change_pct)) && (
                      <span
                        style={{
                          color: Number(quote.change_pct) >= 0 ? "#2e7d32" : "#c62828",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: "0.9em",
                        }}
                        aria-label={`${
                          Number(quote.change_pct) >= 0 ? "Up" : "Down"
                        } ${Math.abs(Number(quote.change_pct)).toFixed(2)} percent`}
                        title={`${
                          Number(quote.change_pct) >= 0 ? "Up" : "Down"
                        } ${Math.abs(Number(quote.change_pct)).toFixed(2)}%`}
                      >
                        {Number(quote.change_pct) >= 0 ? "▲" : "▼"}{" "}
                        {(Number(quote.current_price) - Number(quote.last_close)).toFixed(2)}{" "}
                        ({Math.abs(Number(quote.change_pct)).toFixed(2)}%)
                      </span>
                    )}
                  </p>

                  {/* mini interactive chart (clipped) */}
                  <div style={{ marginTop: 6 }}>
                    {closes.length >= 2 ? (
                      <div style={{ borderRadius: 10, overflow: "hidden" }}>
                        <InteractivePriceChart
                          data={closes}
                          labels={closeDates}
                          width={320}
                          height={80}
                        />
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 12 }}>no chart data</div>
                    )}
                  </div>
                  {closes.length >= 2 && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      drag to pan • wheel to zoom • double-click to reset
                    </div>
                  )}
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>N/A</p>
              )}
            </div>

            {/* Earnings */}
            <div className="card" style={{ minWidth: 0, flex: "1 1 300px" }}>
              <EarningsCard earnings={earnings} />
            </div>

            {/* Recommendation */}
            <div className="card" style={{ minWidth: 0, flex: "1 1 300px" }}>
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

          {/* --- Actual vs Predicted (chart + table) --- */}
          {results.length > 0 && closes.length >= 2 && (
            <div className="card" style={{ marginTop: 12 }}>
              <h3 style={{ marginTop: 0 }}>Actual vs. Predicted</h3>

              {/* Chart */}
              <div style={{ height: 260, borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,0.03)", padding: 8 }}>
                <Chart type="line" data={avpChartData} options={avpChartOptions} />
              </div>

              {/* Table */}
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ whiteSpace: "nowrap" }}>Date</th>
                      <th>Actual</th>
                      {results.map((r) => (
                        <th key={r.model}>
                          {r.model}
                          <span className="muted" style={{ fontSize: 11, display: "block" }}>
                            <em>past: backtest • future: current</em>
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {avpRows.map((row, i) => (
                      <tr key={`${row.kind}-${row.date || i}`}>
                        <td>
                          {row.date
                            ? row.kind === "future"
                              ? `${row.date} (+${i - pastRows.length + 1}d)`
                              : row.date
                            : ""}
                        </td>
                        <td>{row.actual != null ? Number(row.actual).toFixed(2) : "—"}</td>
                        {row.perModel.map((v, j) => (
                          <td key={j}>{v != null ? Number(v).toFixed(2) : "—"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {!!diagnostic && (
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Note: {diagnostic}
                </div>
              )}
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

          {/* Forecast Table (original) — shows confidence when present */}
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
                    {results.map(({ model, predictions, confidence }) => (
                      <tr key={model}>
                        <td>{model}</td>
                        {predictions.map((val, i) => (
                          <td key={i}>
                            {Number(val).toFixed(2)}
                            {Array.isArray(confidence) && confidence[i] != null && (
                              <div className="muted" style={{ fontSize: 11 }}>
                                conf {Number(confidence[i]).toFixed(2)}
                              </div>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!!diagnostic && (
                <div className="muted" style={{ fontSize: 11, padding: "6px 12px 10px" }}>
                  Note: {diagnostic}
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* Big chart modal */}
      {showBigPriceChart && (
        <MagnifyModal title={`${ticker} • Price`} onClose={() => setShowBigPriceChart(false)}>
          <div style={{ borderRadius: 12, overflow: "hidden" }}>
            <InteractivePriceChart data={closes || []} labels={closeDates || []} width={800} height={300} big />
          </div>
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

  // label prefers real date when provided (timezone-safe)
  let label;
  if (Array.isArray(labels) && labels.length === data.length) {
    const d = labels[showIdx];
    try {
      const dt = asLocalDate(d);
      label = dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      label = String(d);
    }
  } else {
    const rel = (data.length - 1) - showIdx; // 0 = latest
    label = rel === 0 ? "latest" : `t-${rel}d`;
  }

  const textW = Math.min(200, 72 + String(label).length * 6);
  const boxX = Math.min(showX + 8, width - (textW + 10));
  const boxY = Math.max(showY - 26, 2);

  return (
    <svg
      width={width}
      height={height}
      style={{
        cursor: drag ? "grabbing" : "crosshair",
        background: "transparent",
        borderRadius: 8,
        display: "block",
        maxWidth: "100%",
      }}
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
          <line x1={showX} x2={showX} y1={10} y2={height - 10} stroke="#a8b2ff" strokeDasharray="3,3" />
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
          Tip: drag to pan • wheel to zoom • double-click to reset
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}
