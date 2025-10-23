// frontend/src/App.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchPredict,
  fetchQuote,
  fetchEarnings,
  fetchMarket,
  fetchCloses,
  fetchPredictHistory,
  buildQuoteStreamURL,
  ping, // 🔔 pre-warm backend
} from "./api";
import MarketCard from "./components/MarketCard";
import EarningsCard from "./components/EarningsCard";
import RecommendationCard from "./components/RecommendationCard";
import MetricsList from "./components/MetricsList";
import WatchlistPanel from "./components/WatchlistPanel";
// ⛔️ removed custom useEventSource to avoid hook-order issues
import useTweenNumber from "./hooks/useTweenNumber";
import CompareMode from "./components/CompareMode";
import HotAndEarnings from "./components/HotAndEarnings";
import AuthModal from "./components/AuthModal";
import { useAuth } from "./auth/AuthContext";
import SentimentOverlay from "./components/SentimentOverlay";
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

// normalize model keys so we don’t miss due to case/whitespace
const normModel = (s) => String(s || "").trim().toUpperCase();
const dkey = (s) => String(s).slice(0, 10);

/** ===== Tail de-dupe helpers (fix duplicate final day) ===== */
const dropDupTailSeries = (dates = [], closes = []) => {
  const n = Math.min(dates.length, closes.length);
  if (n >= 2) {
    const sameVal = Number(closes[n - 1]) === Number(closes[n - 2]);
    const diffDate = String(dates[n - 1]) !== String(dates[n - 2]);
    if (sameVal && diffDate) {
      return {
        dates: dates.slice(0, n - 1),
        closes: closes.slice(0, n - 1),
        dropped: true,
      };
    }
  }
  return { dates, closes, dropped: false };
};

const dropDupTailHistory = (rows = []) => {
  const n = rows.length;
  if (n >= 2) {
    const a = Number(rows[n - 1]?.actual ?? rows[n - 1]?.close);
    const b = Number(rows[n - 2]?.actual ?? rows[n - 2]?.close);
    const dA = String(rows[n - 1]?.date || "");
    const dB = String(rows[n - 2]?.date || "");
    if (dA !== dB && Number.isFinite(a) && Number.isFinite(b) && a === b) {
      return rows.slice(0, n - 1);
    }
  }
  return rows;
};

// If we have a quote, force the last daily close to match the official last_close
function sanitizeClosesWithQuote({ dates, closes, quote }) {
  let outDates = Array.isArray(dates) ? [...dates] : [];
  let outCloses = Array.isArray(closes) ? [...closes] : [];
  if (!outDates.length || outDates.length !== outCloses.length) {
    return { dates: [], closes: [] };
  }

  const lastIdx = outCloses.length - 1;
  if (lastIdx >= 0 && Number.isFinite(Number(quote?.last_close))) {
    outCloses[lastIdx] = Number(quote.last_close);
  }

  const dropped = dropDupTailSeries(outDates, outCloses);
  return { dates: dropped.dates, closes: dropped.closes };
}

/* ---------- robust scroll helpers ---------- */
function getScrollableAncestor(el) {
  let node = el?.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    const canScroll =
      /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    if (canScroll) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
function scrollToTarget(el) {
  if (!el) return;
  const scroller = getScrollableAncestor(el);
  const elRect = el.getBoundingClientRect();
  const scRect =
    scroller === document.documentElement
      ? { top: 0 }
      : scroller.getBoundingClientRect();
  const current =
    scroller === document.documentElement ? window.pageYOffset : scroller.scrollTop;
  const top = current + (elRect.top - scRect.top) - 8;
  if (scroller === document.documentElement) {
    window.scrollTo({ top, behavior: "smooth" });
  } else {
    scroller.scrollTo({ top, behavior: "smooth" });
  }
}
function scrollMainInfoNow() {
  const el = document.getElementById("main-stock-info");
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (el) {
    const top = el.getBoundingClientRect().top + window.pageYOffset - 8;
    window.scrollTo({ top, behavior: "smooth" });
  }
}

/** Simple error boundary so a runtime error never blanks the whole app */
function ErrorBoundary({ children }) {
  const [err, setErr] = useState(null);
  useEffect(() => {
    const handler = (e) => setErr(e?.error || e);
    window.addEventListener("error", handler);
    window.addEventListener("unhandledrejection", handler);
    return () => {
      window.removeEventListener("error", handler);
      window.removeEventListener("unhandledrejection", handler);
    };
  }, []);
  if (err) {
    return (
      <div className="card" style={{ margin: 16, borderLeft: "4px solid #ff6b6b" }}>
        <h3 style={{ marginTop: 0 }}>Something went wrong</h3>
        <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
          {String(err?.message || err)}
        </div>
      </div>
    );
  }
  return children;
}

export default function App() {
  const { user, logout } = useAuth();
  const [showAuth, setShowAuth] = useState(false);

  const [ticker, setTicker] = useState("AAPL");
  const [models, setModels] = useState(["LSTM", "ARIMA"]);

  // Compare Mode (controlled)
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSymbols, setCompareSymbols] = useState([]);

  // Data states
  const [quote, setQuote] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [market, setMarket] = useState(null);

  // Errors / diagnostics
  const [quoteErr, setQuoteErr] = useState(false);
  const [earningsErr, setEarningsErr] = useState(false);
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState("");

  // Predictions (forward)
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  // Live stream
  const [live, setLive] = useState(true);
  const prevPriceRef = useRef(null);
  const tweenPrice = useTweenNumber(quote?.current_price ?? 0, { duration: 450 });
  const [blinkClass, setBlinkClass] = useState("");

  // Price chart data (main card)
  const [closes, setCloses] = useState([]);
  const [closeDates, setCloseDates] = useState([]);
  const [showBigPriceChart, setShowBigPriceChart] = useState(false);

  // Retrospective history rows from backend (for “Actual” and backtests)
  const [historyRows, setHistoryRows] = useState([]);

  // Protect against out-of-order async writes
  const reqVer = useRef(0);

  // Abort stale in-flight fetches (so old responses can't overwrite)
  const abortRef = useRef(null);

  // Where to scroll when a symbol is chosen from the movers table
  const mainSectionRef = useRef(null);

  // 🔔 Listen for global ticker:set so clicks from movers/earnings always scroll & set
  useEffect(() => {
    const handler = (e) => {
      const sym = String(e?.detail || "").toUpperCase().trim();
      if (sym) setTicker(sym);
      requestAnimationFrame(() => requestAnimationFrame(scrollMainInfoNow));
    };
    window.addEventListener("ticker:set", handler);
    return () => window.removeEventListener("ticker:set", handler);
  }, []);

  // Pre-warm backend right after mount to reduce cold-start timeouts
  useEffect(() => {
    (async () => {
      try { await ping(); } catch {}
      setTimeout(() => { ping().catch(() => {}); }, 2500);
    })();
  }, []);

  // Helpers
  const normalizeCloses = (arr) => {
    if (!Array.isArray(arr)) return [];
    const cleaned = arr.map(Number).filter((v) => Number.isFinite(v));
    return cleaned.length >= 2 ? cleaned : [];
  };

  const fetchClosesSafe = async (tkr, signal) => {
    const tryOnce = async (days) => {
      try {
        const r = await fetchCloses(tkr, days, { signal });
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
      byDate[dk] = {
        ...r,
        actual: Number.isFinite(+r.actual) ? +r.actual : Number.isFinite(+r.close) ? +r.close : null,
      };
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

    // cancel any in-flight request from the previous run
    try { abortRef.current?.abort?.(); } catch {}
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Reset errors (keep existing data visible during refresh)
    setError("");
    setDiagnostic("");
    setQuoteErr(false);
    setEarningsErr(false);
    setLoading(true);

    const t = String(ticker || "").toUpperCase().trim();

    // 1) Quote — awaited, used by closes sanitization
    const pQuote = (async () => {
      try {
        const q = await fetchQuote(t, { signal: ctrl.signal });
        if (reqVer.current !== myVer) return null;
        setQuote(q);
        prevPriceRef.current = q.current_price;
        if (!live) setLive(true);
        return q;
      } catch {
        if (reqVer.current !== myVer) return null;
        setQuoteErr(true);
        setDiagnostic((d) => d || `Quote fetch failed for ${t}.`);
        return null;
      }
    })();

    // 2) Earnings
    const pEarn = (async () => {
      try {
        const e = await fetchEarnings(t, { signal: ctrl.signal });
        if (reqVer.current !== myVer) return;
        setEarnings(e);
      } catch {
        if (reqVer.current !== myVer) return;
        setEarningsErr(true);
      }
    })();

    // 3) Market
    const pMkt = (async () => {
      try {
        const m = await fetchMarket({ signal: ctrl.signal });
        if (reqVer.current !== myVer) return;
        setMarket(m);
      } catch {
        /* ignore */
      }
    })();

    // 3.5) Closes (align with quote + drop duplicate tail)
    const pCloses = (async () => {
      try {
        const raw = await fetchClosesSafe(t, ctrl.signal);
        if (reqVer.current !== myVer) return;
        const q = await pQuote.catch(() => null);

        const { dates, closes } = sanitizeClosesWithQuote({
          dates: raw?.dates || [],
          closes: raw?.closes || [],
          quote: q,
        });

        if (!closes?.length) {
          setDiagnostic((dMsg) => dMsg || `No historical price series available for ${t}.`);
        }

        setCloses(closes || []);
        setCloseDates(dates || []);
      } catch {
        if (reqVer.current !== myVer) return;
        setDiagnostic((dMsg) => dMsg || `Failed to load historical prices for ${t}.`);
      }
    })();

    // 4) Past backtest rows (drop duplicate tail if backend repeats it)
    const pHist = (async () => {
      try {
        const hist = await fetchPredictHistory({ ticker: t, models, days: 15 }, { signal: ctrl.signal });
        if (reqVer.current !== myVer) return;
        const safeRows = (Array.isArray(hist?.rows) ? hist.rows : []).map((r) => ({
          ...r,
          actual: Number.isFinite(+r?.actual) ? +r.actual : Number.isFinite(+r?.close) ? +r.close : null,
        }));
        setHistoryRows(dropDupTailHistory(safeRows));
      } catch {
        if (reqVer.current !== myVer) return;
        setHistoryRows([]);
      }
    })();

    // 5) Current forward predictions
    const pPredict = (async () => {
      try {
        const res = await fetchPredict({ ticker: t, models }, { signal: ctrl.signal });
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

    await Promise.all([pQuote, pEarn, pMkt, pCloses, pHist, pPredict].map((p) => p?.catch?.(() => {})));

    if (reqVer.current === myVer) {
      setLoading(false);
    }
  }, [ticker, models, live]);

  // kick off loads and abort on unmount
  useEffect(() => {
    loadData();
    return () => {
      try { abortRef.current?.abort?.(); } catch {}
    };
  }, [loadData]);

  // 🔄 Inline SSE (replaces useEventSource). Hook order is stable across renders.
  useEffect(() => {
    if (!live || !ticker) return;
    const url = buildQuoteStreamURL(ticker, 5);
    let es;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
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
      } catch {
        /* ignore parse issues */
      }
    };
    es.onerror = () => {
      try { es.close(); } catch {}
    };
    return () => {
      try { es.close(); } catch {}
    };
  }, [live, ticker]);

  const handleSubmit = (e) => {
    e.preventDefault();
    loadData();
  };

  const toggleModel = (m) =>
    setModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  // When user clicks a symbol in movers table (prop path)
  const handleSelectTicker = (sym) => {
    const t = String(sym || "").toUpperCase().trim();
    if (!t) return;
    setTicker(t);
    const go = () => scrollToTarget(mainSectionRef.current);
    requestAnimationFrame(() => requestAnimationFrame(go));
  };

  // ➕ Add from Watchlist into Compare (was missing earlier → crash)
  const handleAddToCompare = (sym) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    setCompareSymbols((prev) => {
      const next = [...new Set([...(prev || []), s])];
      return next.slice(0, 3);
    });
    setCompareOpen(true);
  };

  // Client-side metrics & recommendation
  const metrics = useMemo(() => {
    if (!quote || !results?.length) return [];
    const base = Number(quote.last_close) || 0;
    if (base <= 0) return [];
    return results.map((r) => {
      const preds = (Array.isArray(r.predictions) ? r.predictions : []).map(Number).filter(Number.isFinite);
      if (!preds.length) return { model: r.model, mapeProxy: Infinity, avgChangePct: 0 };
      const mapeProxy = preds.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) / preds.length;
      const meanPred = preds.reduce((a, b) => a + b, 0) / preds.length;
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

  // ---------- Actual vs. Predicted ----------
  const horizon = results?.[0]?.predictions?.length || 0;

  const pastDaysToShow = 10;
  const pastLabels = (histDates.length ? histDates : closeDates).slice(-pastDaysToShow);

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

  const chartLabels = [...pastLabels, ...futureLabels];

  // “Actual” from closes; fallback to historyRows only if needed
  const actualForPastLabelsRaw = pastLabels.map((iso) => {
    const idx = closeDates.lastIndexOf(iso);
    return idx >= 0 ? closes[idx] : histByDate[iso]?.actual ?? null;
  });

  // pin the last “actual” to quote.last_close for stability
  const actualForPastLabels = (() => {
    const arr = [...actualForPastLabelsRaw];
    const lastIdx = arr.length - 1;
    if (lastIdx >= 0 && Number.isFinite(Number(quote?.last_close))) {
      arr[lastIdx] = Number(quote.last_close);
    }
    return arr;
  })();

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

  const pastRows = pastLabels.map((iso, i, arr) => {
    const dk = dkey(iso);
    const row = histByDate[dk];
    const idx = closeDates.lastIndexOf(iso);
    let actual = idx >= 0 ? closes[idx] : row?.actual ?? null;

    // last past day: force to official last_close to avoid early/late-day drift
    if (i === arr.length - 1 && Number.isFinite(Number(quote?.last_close))) {
      actual = Number(quote.last_close);
    }

    const perModel = results.map((r) => {
      const v = histPred?.[dk]?.[normModel(r.model)];
      return Number.isFinite(Number(v)) ? Number(v) : null;
    });
    return { date: iso, actual, perModel, kind: "past" };
  });

  const futureRows = futureLabels.map((d, i) => {
    const perModel = results.map((r) => r.predictions?.[i] ?? null);
    return { date: d, actual: null, perModel, kind: "future" };
  });

  return (
    <ErrorBoundary>
      <div className="app-root">
        {/* Hero header (centered) */}
        <div className="hero-wrap">
          <div className="hero hero--center">
            <div>
              <h1 className="hero-title">Real-Time Stock & Crypto Dashboard</h1>
              <p className="hero-sub">Live quotes • Movers • This week’s earnings</p>
            </div>
            <div className="hero-right" style={{ display: "flex", gap: 8 }}>
              {user ? (
                <>
                  <span className="muted" style={{ fontSize: 14 }}>
                    👋 {user?.name || user?.email}
                  </span>
                  <button className="btn ghost" onClick={logout} title="Sign out">
                    Sign out
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => setShowAuth(true)}>
                  Sign in / Create account
                </button>
              )}
              <button className="btn ghost" onClick={() => window.location.reload()}>
                ↻ Refresh
              </button>
            </div>
          </div>

          {/* Scoped hero styles */}
          <style>{`
            .hero-wrap { margin: 6px 0 12px; }
            .hero {
              display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
              padding: 18px 16px;
              border-radius: 16px;
              background: radial-gradient(140% 160% at 100% 0%, rgba(160,170,255,0.10), rgba(25,28,45,0.65) 55%, rgba(17,20,35,0.85));
              border: 1px solid rgba(255,255,255,0.08);
              box-shadow: 0 8px 22px rgba(0,0,0,0.28);
            }
            .hero-title {
              margin: 0;
              font-size: clamp(22px, 3.6vw, 36px);
              letter-spacing: .3px;
              line-height: 1.15;
            }
            .hero-sub { margin: 4px 0 0; color: #a7adbc; font-size: 13px; }
            .hero-right { display: flex; align-items: center; gap: 8px; }

            /* Centered variant */
            .hero--center {
              flex-direction: column;
              align-items: center;
              justify-content: center;
              text-align: center;
            }
            .hero--center .hero-right { margin-top: 8px; }

            @media (max-width: 720px) {
              .hero { flex-direction: column; align-items: flex-start; }
              .hero--center { align-items: center; }
              .hero-right { width: 100%; justify-content: center; }
            }
          `}</style>
        </div>

        <main className="container grid-2col">
          {/* LEFT: Watchlist */}
          <aside className="left-rail">
            <WatchlistPanel
              current={ticker}
              onLoad={(s) => setTicker(s)}
              onAddToCompare={handleAddToCompare}
            />
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
                symbols={compareSymbols}
                onSymbolsChange={setCompareSymbols}
                defaultModels={models}
                rememberSession={false}
                onExit={() => setCompareOpen(false)}
              />
            )}

            {/* Hot movers + Earnings next 7d */}
            <HotAndEarnings onSelectTicker={handleSelectTicker} />

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

            {/* >>> Anchor for smooth-scroll target (just above info cards) <<< */}
            <div
              id="main-stock-info"
              ref={mainSectionRef}
              style={{ scrollMarginTop: 12, height: 0, overflow: "hidden" }}
              aria-hidden
            />

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
                    <p style={{ margin: 0 }}>
                      Last Close: ${Number(quote.last_close).toFixed(2)}
                    </p>
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
                        <div className="muted" style={{ fontSize: 12 }}>
                          no chart data
                        </div>
                      )}
                    </div>
                    {closes.length >= 2 && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        drag to pan • wheel to zoom • double-click to reset
                      </div>
                    )}
                  </>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>
                    N/A
                  </p>
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

            {/* 📰 Sentiment overlay */}
            <div className="card" style={{ marginTop: 12 }}>
              <SentimentOverlay ticker={ticker} days={120} />
            </div>

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

                <div
                  style={{
                    height: 260,
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "rgba(255,255,255,0.03)",
                    padding: 8,
                }}>
                  <Chart type="line" data={avpChartData} options={avpChartOptions} />
                </div>

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
                      {[...pastRows, ...futureRows].map((row, i) => (
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

            {diagnostic && (
              <div className="card" style={{ borderLeft: "4px solid #a8b2ff", marginTop: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Diagnostics</div>
                <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{diagnostic}</div>
              </div>
            )}

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

            {/* Forecast Table */}
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
              <InteractivePriceChart
                data={closes || []}
                labels={closeDates || []}
                width={800}
                height={300}
                big
              />
            </div>
          </MagnifyModal>
        )}

        {/* 🔐 Auth modal mount */}
        <AuthModal open={showAuth && !user} onClose={() => setShowAuth(false)} />
      </div>
    </ErrorBoundary>
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
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
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
