// frontend/src/App.jsx
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  fetchPredict,
  fetchQuote,
  fetchEarnings,
  fetchMarket,
  fetchCloses,
  fetchPredictHistory,
  buildQuoteStreamURL,
  ping,
} from "./api";
import MarketCard from "./components/MarketCard";
import EarningsCard from "./components/EarningsCard";
import RecommendationCard from "./components/RecommendationCard";
import MetricsList from "./components/MetricsList";
import WatchlistPanel from "./components/WatchlistPanel";
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

/* =========================
   Date + math helpers
   ========================= */
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

const isWeekend = (dt) => [0, 6].includes(dt.getDay());
const prevBiz = (iso) => {
  let d = asLocalDate(iso);
  do d.setDate(d.getDate() - 1);
  while (isWeekend(d));
  return fmtLocalISO(d);
};
const nextBiz = (iso) => {
  let d = asLocalDate(iso);
  do d.setDate(d.getDate() + 1);
  while (isWeekend(d));
  return fmtLocalISO(d);
};

const normModel = (s) => String(s || "").trim().toUpperCase();
const dkey = (s) => String(s).slice(0, 10);

const toNum = (x) => (Number.isFinite(+x) ? +x : null);

const safePct = (curr, prev) =>
  Number.isFinite(curr) && Number.isFinite(prev) && prev !== 0
    ? ((curr - prev) / prev) * 100
    : null;

/* =========================
   Tail cleanup helpers
   ========================= */
const SPLIT_RATIO_THRESHOLD = 2.0;

// Dedupe if vendor duplicated last value across 2 dates
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

// Clean weird tail rows in predict_history
function dropDupTailHistory(rows = []) {
  const arr = Array.isArray(rows) ? [...rows] : [];
  const n = arr.length;
  if (n < 2) return arr;

  const getActual = (row) => {
    const a = Number(row?.actual);
    if (Number.isFinite(a)) return a;
    const c = Number(row?.close);
    if (Number.isFinite(c)) return c;
    return null;
  };

  const lastA = getActual(arr[n - 1]);
  const prevA = getActual(arr[n - 2]);

  // Step 1: kill obvious split-scale mismatch on last row
  if (Number.isFinite(lastA) && Number.isFinite(prevA) && prevA !== 0) {
    const ratio = Math.abs(lastA / prevA);
    if (ratio > SPLIT_RATIO_THRESHOLD || ratio < 1 / SPLIT_RATIO_THRESHOLD) {
      arr.pop();
    }
  }

  // Step 2: drop duplicate price across 2 different dates at tail
  const m = arr.length;
  if (m >= 2) {
    const aVal = getActual(arr[m - 1]);
    const bVal = getActual(arr[m - 2]);
    const dA = String(arr[m - 1]?.date || "");
    const dB = String(arr[m - 2]?.date || "");

    if (
      dA !== dB &&
      Number.isFinite(aVal) &&
      Number.isFinite(bVal) &&
      aVal === bVal
    ) {
      arr.pop();
    }
  }

  return arr;
}

/* =========================
   Price-series sanitizing
   ========================= */
// We try not to nuke the entire series scale unless it's super obviously split.
// We DO NOT blindly pin the last element to quote.last_close anymore if
// quote.last_close looks like today's live price.
function sanitizeClosesWithQuote({ dates, closes, quote }) {
  let outDates = Array.isArray(dates) ? [...dates] : [];
  let outCloses = Array.isArray(closes)
    ? closes.map(Number).filter(Number.isFinite)
    : [];

  if (!outDates.length || outDates.length !== outCloses.length) {
    return { dates: [], closes: [] };
  }

  const providerLastRaw = outCloses[outCloses.length - 1]; // last price from vendor history
  const quoteLast = Number(quote?.last_close);
  const quoteCurr = Number(quote?.current_price);

  const haveProvider = Number.isFinite(providerLastRaw) && providerLastRaw > 0;
  const haveQuoteLast = Number.isFinite(quoteLast) && quoteLast > 0;

  if (haveProvider && haveQuoteLast) {
    const ratio = quoteLast / providerLastRaw;

    // is "last_close" basically just today's live price => probably not settled yet
    const looksLikeNow =
      Number.isFinite(quoteCurr) &&
      Math.abs(quoteCurr - quoteLast) / (Math.abs(quoteLast) || 1) < 0.02;

    // only treat as split if it's a huge mismatch
    const bigMismatch = ratio > 1.25 || ratio < 0.8;

    if (!looksLikeNow && bigMismatch) {
      // large scale gap → treat like split, scale whole series
      let scaled = outCloses.map((v) => (Number.isFinite(v) ? v * ratio : v));
      // and force the tail to equal quoteLast
      scaled[scaled.length - 1] = quoteLast;
      outCloses = scaled;
    } else {
      // mild mismatch or quoteLast is sketchy:
      // leave vendor series as-is
    }
  }

  // drop duplicate last rows if vendor glued same price to 2 dates
  const dropped = dropDupTailSeries(outDates, outCloses);
  return { dates: dropped.dates, closes: dropped.closes };
}

/* =========================
   scroll helpers
   ========================= */
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
    scroller === document.documentElement
      ? window.pageYOffset
      : scroller.scrollTop;
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

/* =========================
   App Component
   ========================= */
export default function App() {
  const { user, logout } = useAuth();
  const [showAuth, setShowAuth] = useState(false);

  const [ticker, setTicker] = useState("AAPL");
  const [models, setModels] = useState(["LSTM", "ARIMA"]);

  // Compare Mode
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSymbols, setCompareSymbols] = useState([]);

  // Data
  const [quote, setQuote] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [market, setMarket] = useState(null);

  // Errors / diag
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

  // price chart data
  const [closes, setCloses] = useState([]);
  const [closeDates, setCloseDates] = useState([]);
  const [showBigPriceChart, setShowBigPriceChart] = useState(false);

  // history rows from backend
  const [historyRows, setHistoryRows] = useState([]);

  // loader version guard
  const reqVer = useRef(0);

  // abort controller
  const abortRef = useRef(null);

  // ref to scroll to ticker block
  const mainSectionRef = useRef(null);

  /* ---------- Broadcast ticker selection ---------- */
  useEffect(() => {
    const handler = (e) => {
      const sym = String(e?.detail || "").toUpperCase().trim();
      if (sym) setTicker(sym);
      requestAnimationFrame(() => requestAnimationFrame(scrollMainInfoNow));
    };
    window.addEventListener("ticker:set", handler);
    return () => window.removeEventListener("ticker:set", handler);
  }, []);

  /* ---------- Warm backend ---------- */
  useEffect(() => {
    (async () => {
      try {
        await ping();
      } catch {}
      setTimeout(() => {
        ping().catch(() => {});
      }, 2500);
    })();
  }, []);

  /* ---------- helpers ---------- */
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

  /* ---------- Build lookup from predict_history ---------- */
  const { histPred } = useMemo(() => {
    const byDateModel = {};
    (historyRows || []).forEach((r) => {
      const dk = dkey(r.date);
      const perModel = {};
      Object.entries(r.pred || {}).forEach(([m, v]) => {
        perModel[normModel(m)] = toNum(v);
      });
      byDateModel[dk] = perModel;
    });
    return { histPred: byDateModel };
  }, [historyRows]);

  // Map date -> close for vendor close series (after sanitizeClosesWithQuote)
  const closeMap = useMemo(() => {
    const m = {};
    (closeDates || []).forEach((d, i) => {
      const v = toNum(closes?.[i]);
      if (Number.isFinite(v)) {
        m[dkey(d)] = v;
      }
    });
    return m;
  }, [closeDates, closes]);

  /* ---------- Load data (quote, earnings, etc.) ---------- */
  const loadData = useCallback(async () => {
    const myVer = ++reqVer.current;

    try {
      abortRef.current?.abort?.();
    } catch {}
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setError("");
    setDiagnostic("");
    setQuoteErr(false);
    setEarningsErr(false);
    setLoading(true);

    const t = String(ticker || "").toUpperCase().trim();

    // Quote
    const pQuote = (async () => {
      try {
        const q = await fetchQuote(t, { signal: ctrl.signal });
        if (reqVer.current !== myVer) return null;
        setQuote(q);
        prevPriceRef.current = q?.current_price ?? null;
        if (!live) setLive(true);
        return q;
      } catch {
        if (reqVer.current !== myVer) return null;
        setQuoteErr(true);
        setDiagnostic((d) => d || `Quote fetch failed for ${t}.`);
        return null;
      }
    })();

    // Earnings
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

    // Market
    const pMkt = (async () => {
      try {
        const m = await fetchMarket({ signal: ctrl.signal });
        if (reqVer.current !== myVer) return;
        setMarket(m);
      } catch {
        /* ignore */
      }
    })();

    // Closes (chart series)
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

    // Past predict history rows
    const pHist = (async () => {
      try {
        const hist = await fetchPredictHistory(
          { ticker: t, models, days: 15 },
          { signal: ctrl.signal }
        );
        if (reqVer.current !== myVer) return;
        const safeRows = (Array.isArray(hist?.rows) ? hist.rows : []).map((r) => ({
          ...r,
          actual: toNum(r?.actual) ?? toNum(r?.close) ?? null,
        }));
        setHistoryRows(dropDupTailHistory(safeRows));
      } catch {
        if (reqVer.current !== myVer) return;
        setHistoryRows([]);
      }
    })();

    // forward predictions
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

    await Promise.all(
      [pQuote, pEarn, pMkt, pCloses, pHist, pPredict].map((p) => p?.catch?.(() => {}))
    );

    if (reqVer.current === myVer) {
      setLoading(false);
    }
  }, [ticker, models, live]);

  /* ---------- Run loadData when ticker/models change ---------- */
  useEffect(() => {
    loadData();
    return () => {
      try {
        abortRef.current?.abort?.();
      } catch {}
    };
  }, [loadData]);

  /* ---------- SSE live quote ---------- */
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
        const next = toNum(payload.current_price);
        const lastClose =
          toNum(payload.last_close) ?? toNum(quote?.last_close) ?? null;

        if (next != null) {
          setQuote((q) => {
            const base = q || {};
            const derivedPct = safePct(next, lastClose);
            const pct =
              toNum(payload.change_pct) ??
              derivedPct ??
              toNum(base.change_pct) ??
              0;
            return {
              ...base,
              ticker: payload.ticker ?? base.ticker ?? ticker,
              current_price: next,
              last_close: lastClose,
              change_pct: pct,
            };
          });

          if (prev != null && prev !== next) {
            setBlinkClass(next > prev ? "blink-up" : "blink-down");
            setTimeout(() => setBlinkClass(""), 520);
          }
          prevPriceRef.current = next;
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      try {
        es.close();
      } catch {}
    };
    return () => {
      try {
        es.close();
      } catch {}
    };
  }, [live, ticker, quote?.last_close]);

  /* ---------- UI handlers ---------- */
  const handleSubmit = (e) => {
    e.preventDefault();
    loadData();
  };

  const toggleModel = (m) =>
    setModels((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    );

  const handleSelectTicker = (sym) => {
    const t = String(sym || "").toUpperCase().trim();
    if (!t) return;
    setTicker(t);
    const go = () => scrollToTarget(mainSectionRef.current);
    requestAnimationFrame(() => requestAnimationFrame(go));
  };

  const handleAddToCompare = (sym) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    setCompareSymbols((prev) => {
      const next = [...new Set([...(prev || []), s])];
      return next.slice(0, 3);
    });
    setCompareOpen(true);
  };

  /* ---------- Strict Actuals & aligned backtests ---------- */

  // Actual must come from vendor closes ONLY
  function pickActualForDateStrict(iso, closeMap) {
    const key = dkey(iso);
    const v = toNum(closeMap?.[key]);
    return Number.isFinite(v) ? v : null;
  }

  // Get model backtest for date with ±1 business day fallback
  const getHistPredForDate = (iso, mKey, histPred) =>
    toNum(histPred?.[iso]?.[mKey]) ??
    toNum(histPred?.[prevBiz(iso)]?.[mKey]) ??
    toNum(histPred?.[nextBiz(iso)]?.[mKey]) ??
    null;

  /* ---------- Metrics & Recommendation ---------- */
  const metrics = useMemo(() => {
    if (!quote || !results?.length) return [];
    const base = toNum(quote.last_close) || 0;
    if (base <= 0) return [];
    return results.map((r) => {
      const preds = (Array.isArray(r.predictions) ? r.predictions : [])
        .map(Number)
        .filter(Number.isFinite);
      if (!preds.length)
        return {
          model: r.model,
          mapeProxy: Infinity,
          avgChangePct: 0,
        };
      const mapeProxy =
        preds.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) /
        preds.length;
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

  /* ---------- Actual vs Predicted prep ---------- */

  const horizon = results?.[0]?.predictions?.length || 0;
  const pastDaysToShow = 10;

  // PAST: strictly from vendor closes (no mixing with predict_history dates)
  let pastLabels = (closeDates || []).slice(-pastDaysToShow);

  // Guard: drop a weird duplicated final point or >15% jump
  if (pastLabels.length >= 2) {
    const lastKey = dkey(pastLabels[pastLabels.length - 1]);
    const prevKey = dkey(pastLabels[pastLabels.length - 2]);
    const lastVal = toNum(closeMap?.[lastKey]);
    const prevVal = toNum(closeMap?.[prevKey]);
    if (Number.isFinite(lastVal) && Number.isFinite(prevVal)) {
      const looksDup = lastVal === prevVal;
      const looksSplit = Math.abs(lastVal - prevVal) / (Math.abs(prevVal) || 1) > 0.15;
      if (looksDup || looksSplit) pastLabels = pastLabels.slice(0, -1);
    }
  }

  // Guard: carried-forward pattern (e.g., replayed Friday)
  if (pastLabels.length >= 3) {
    const newestKey = dkey(pastLabels[pastLabels.length - 1]);
    const prevKey = dkey(pastLabels[pastLabels.length - 2]);
    const prevPrevKey = dkey(pastLabels[pastLabels.length - 3]);
    const newestVal = toNum(closeMap?.[newestKey]);
    const prevVal = toNum(closeMap?.[prevKey]);
    const prevPrevVal = toNum(closeMap?.[prevPrevKey]);
    if (
      Number.isFinite(newestVal) &&
      Number.isFinite(prevVal) &&
      Number.isFinite(prevPrevVal)
    ) {
      const clonedFromTwoDaysAgo = newestVal === prevPrevVal;
      const driftPct = Math.abs(newestVal - prevVal) / (Math.abs(prevVal) || 1);
      if (clonedFromTwoDaysAgo && driftPct > 0.02) {
        pastLabels = pastLabels.slice(0, -1);
      }
    }
  }

  // last trusted historical date
  const lastPastDate = pastLabels.length
    ? asLocalDate(pastLabels[pastLabels.length - 1])
    : null;

  // FUTURE: business days AFTER lastPastDate
  const futureLabels = Array.from({ length: horizon }, (_, i) => {
    if (!lastPastDate) return `+${i + 1}d`;
    const d = addBusinessDays(lastPastDate, i + 1);
    return fmtLocalISO(d);
  });

  const chartLabels = [...pastLabels, ...futureLabels];

  // "Actual" strictly from vendor closes
  const actualForPastLabels = pastLabels.map((iso) =>
    pickActualForDateStrict(iso, closeMap)
  );

  // Harmonizer to rescale model backtest onto actual scale if needed
  function harmonize(series, actual) {
    const pairs = [];
    for (let i = 0; i < pastLabels.length; i++) {
      const a = actual[i];
      const b = series[i];
      if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
    }
    if (pairs.length < 5) return { series, note: null };

    const A = pairs.map((p) => p[0]);
    const B = pairs.map((p) => p[1]);

    const median = (xs) => {
      const s = [...xs].sort((x, y) => x - y);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    const medA = median(A);
    const medB = median(B);
    const scaleRatio = medB && medA ? medA / medB : 1;

    const mape =
      A.reduce((acc, a, i) => acc + Math.abs(a - B[i]) / (Math.abs(a) || 1), 0) /
      A.length;

    if (mape > 0.2 && (scaleRatio < 0.8 || scaleRatio > 1.2)) {
      const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
      const meanA = mean(A);
      const meanB = mean(B);
      const cov =
        A.reduce((s, a, i) => s + (a - meanA) * (B[i] - meanB), 0) / A.length;
      const varB =
        B.reduce((s, b) => s + (b - meanB) * (b - meanB), 0) / B.length || 1;
      const beta = cov / varB;
      const alpha = meanA - beta * meanB;

      const adjusted = series.map((b) => (Number.isFinite(b) ? alpha + beta * b : null));
      return {
        series: adjusted,
        note: `Backtests rescaled (α=${alpha.toFixed(2)}, β=${beta.toFixed(3)}) to match actuals.`,
      };
    }

    return { series, note: null };
  }

  const colorPalette = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc949"];

  // datasets for Actual vs Predicted chart
  const { avpDatasets, harmonizeNote } = useMemo(() => {
    if (!chartLabels.length) return { avpDatasets: [], harmonizeNote: null };

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

    let note = null;

    results.forEach((r, idx) => {
      const color = colorPalette[idx % colorPalette.length];
      const mKey = normModel(r.model);

      // backtest aligned to vendor pastLabels with ±1d fallback
      const backtestRaw = pastLabels.map((iso) =>
        getHistPredForDate(dkey(iso), mKey, histPred)
      );

      const { series: backtestSeries, note: n } = harmonize(
        backtestRaw,
        actualForPastLabels
      );
      if (n && !note) note = n;

      ds.push({
        label: `${r.model} • backtest`,
        data: backtestSeries.concat(Array(futureLabels.length).fill(null)),
        borderColor: color,
        backgroundColor: "transparent",
        borderDash: [6, 4],
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.2,
        spanGaps: true,
      });

      // future/current forecast line
      const lastActual =
        [...actualForPastLabels].reverse().find((v) => Number.isFinite(v)) ?? null;

      const currentSeries = [
        ...Array(Math.max(0, pastLabels.length - 1)).fill(null),
        lastActual,
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

    return { avpDatasets: ds, harmonizeNote: note };
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
      y: {
        ticks: {
          callback: (v) => `$${Number(v).toFixed(0)}`,
        },
      },
    },
  };

  // backtest values aligned to "Actual" scale for the table
  const alignedBacktestsByModel = useMemo(() => {
    const out = {};
    results.forEach((r) => {
      const mKey = normModel(r.model);
      const rawSeries = pastLabels.map((iso) =>
        getHistPredForDate(dkey(iso), mKey, histPred)
      );
      const { series } = harmonize(rawSeries, actualForPastLabels);
      out[mKey] = series;
    });
    return out;
  }, [results, histPred, pastLabels.join("|"), actualForPastLabels.join("|")]);

  // table rows for AVP table (past + future)
  const pastRows = pastLabels.map((iso, idx) => {
    const actualHere = pickActualForDateStrict(iso, closeMap);
    const perModel = results.map((r) => {
      const mKey = normModel(r.model);
      const v = alignedBacktestsByModel[mKey]?.[idx];
      return Number.isFinite(Number(v)) ? Number(v) : null;
    });
    return { date: iso, actual: actualHere, perModel, kind: "past" };
  });

  const futureRows = futureLabels.map((d, i) => {
    const perModel = results.map((r) =>
      Array.isArray(r.predictions) ? r.predictions[i] ?? null : null
    );
    return { date: d, actual: null, perModel, kind: "future" };
  });

  /* ---------- Header price / pct change ---------- */
  const curr = toNum(quote?.current_price);
  const prev = toNum(quote?.last_close);
  const derivedPct = safePct(curr, prev);
  const pctToShow = toNum(quote?.change_pct) ?? derivedPct ?? 0;
  const absToShow =
    Number.isFinite(curr) && Number.isFinite(prev) ? curr - prev : 0;

  /* ---------- Render ---------- */
  return (
    <div className="app-root">
      {/* hero */}
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

          {/* Movers + Earnings */}
          <HotAndEarnings onSelectTicker={handleSelectTicker} />

          {/* ticker input */}
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

          {/* anchor for scroller */}
          <div
            id="main-stock-info"
            ref={mainSectionRef}
            style={{ scrollMarginTop: 12, height: 0, overflow: "hidden" }}
            aria-hidden
          />

          {/* Top info row */}
          <div className={`row ${blinkClass ? blinkClass : ""}`} style={{ gap: 16, marginBottom: 12 }}>
            {/* Quote card */}
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
                    Last Close:{" "}
                    {Number.isFinite(quote.last_close)
                      ? `$${Number(quote.last_close).toFixed(2)}`
                      : "—"}
                  </p>
                  <p style={{ margin: "2px 0", display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontSize: "1.3em", fontWeight: 600 }}>
                      ${tweenPrice.toFixed(2)}
                    </span>
                    {Number.isFinite(pctToShow) && (
                      <span
                        style={{
                          color: pctToShow >= 0 ? "#2e7d32" : "#c62828",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: "0.9em",
                        }}
                        aria-label={`${pctToShow >= 0 ? "Up" : "Down"} ${Math.abs(pctToShow).toFixed(2)} percent`}
                        title={`${pctToShow >= 0 ? "Up" : "Down"} ${Math.abs(pctToShow).toFixed(2)}%`}
                      >
                        {pctToShow >= 0 ? "▲" : "▼"} {Number(absToShow).toFixed(2)} (
                        {Math.abs(pctToShow).toFixed(2)}%)
                      </span>
                    )}
                  </p>

                  {/* mini chart */}
                  <div style={{ marginTop: 6 }}>
                    {closes.length >= 2 ? (
                      <div style={{ borderRadius: 10, overflow: "hidden" }}>
                        <InteractivePriceChart data={closes} labels={closeDates} width={320} height={80} />
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

            {/* Earnings card */}
            <div className="card" style={{ minWidth: 0, flex: "1 1 300px" }}>
              <EarningsCard earnings={earnings} />
            </div>

            {/* Recommendation */}
            <div className="card" style={{ minWidth: 0, flex: "1 1 300px" }}>
              <RecommendationCard recommendation={recommendation} />
            </div>
          </div>

          {/* Market snapshot */}
          {market && (
            <div className="card">
              <MarketCard market={market} />
            </div>
          )}

          {/* sentiment */}
          <div className="card" style={{ marginTop: 12 }}>
            <SentimentOverlay ticker={ticker} days={120} />
          </div>

          {/* model metrics */}
          {!!metrics.length && (
            <div className="card" style={{ marginTop: 12, marginBottom: 12 }}>
              <MetricsList metrics={metrics} />
            </div>
          )}

          {/* Actual vs Predicted */}
          {results.length > 0 && pastLabels.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <h3 style={{ marginTop: 0 }}>Actual vs. Predicted</h3>

              <div
                style={{
                  height: 260,
                  borderRadius: 12,
                  overflow: "hidden",
                  background: "rgba(255,255,255,0.03)",
                  padding: 8,
                }}
              >
                <Chart type="line" data={avpChartData} options={avpChartOptions} />
              </div>

              {/* Table */}
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <div
                  className="muted"
                  style={{ fontSize: 12, marginBottom: 6, fontWeight: 500, color: "#9ea2ff" }}
                >
                  Model Comparison (past: backtest • future: current)
                </div>

                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ whiteSpace: "nowrap" }}>Date</th>
                      <th>Actual</th>
                      {results.map((r) => (
                        <th key={r.model}>{r.model}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...pastRows, ...futureRows].map((row, i) => (
                      <tr
                        key={`${row.kind}-${row.date || i}`}
                        style={row.kind === "future" ? { background: "rgba(0,255,0,0.04)" } : {}}
                      >
                        <td
                          style={
                            row.kind === "future"
                              ? { color: "#6cfb8d", fontWeight: 600 }
                              : { fontWeight: 500 }
                          }
                        >
                          {row.date
                            ? row.kind === "future"
                              ? `${row.date} (+${i - pastRows.length + 1}d)`
                              : row.date
                            : ""}
                        </td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>
                          {row.actual != null ? Number(row.actual).toFixed(2) : "—"}
                        </td>
                        {row.perModel.map((v, j) => (
                          <td key={j} style={{ fontVariantNumeric: "tabular-nums" }}>
                            {v != null ? Number(v).toFixed(2) : "—"}
                          </td>
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
              {!!harmonizeNote && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {harmonizeNote}
                </div>
              )}
            </div>
          )}

          {diagnostic && (
            <div className="card" style={{ borderLeft: "4px solid #a8b2ff", marginTop: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Diagnostics</div>
              <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                {diagnostic}
              </div>
            </div>
          )}

          {error && <p style={{ color: "red" }}>Prediction Error: {error}</p>}

          {/* model selector */}
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

          {/* forecast table */}
          {results.length > 0 && (
            <div className="card table-card">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      {Array.from({ length: results?.[0]?.predictions?.length || 0 }).map(
                        (_, i) => (
                          <th key={i}>{`+${i + 1}d`}</th>
                        )
                      )}
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

      {/* Auth modal */}
      <AuthModal open={showAuth && !user} onClose={() => setShowAuth(false)} />
    </div>
  );
}

/* =========================
   InteractivePriceChart + MagnifyModal
   ========================= */

function InteractivePriceChart({ data = [], labels = [], width = 320, height = 80, big = false }) {
  const pad = 10;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const [view, setView] = useState({
    start: 0,
    end: Math.max(0, data.length - 1),
  });
  const [cursorX, setCursorX] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [drag, setDrag] = useState(null); // {startX, startView}

  useEffect(() => {
    setView({
      start: 0,
      end: Math.max(0, data.length - 1),
    });
  }, [data.length]);

  if (!Array.isArray(data) || data.length < 2) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        no data
      </div>
    );
  }

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
    if (drag) {
      const dx = x - drag.startX;
      const frac = dx / w;
      const windowSize = drag.startView.end - drag.startView.start;
      let newStart = drag.startView.start - Math.round(frac * windowSize);
      let newEnd = newStart + windowSize;
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
    newSize = Math.max(5, Math.min(newSize, data.length - 1));

    let newStart = focusIdx - Math.round(((focusIdx - vStart) * newSize) / windowSize);
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

  const onDblClick = () =>
    setView({
      start: 0,
      end: data.length - 1,
    });

  const showIdx = clamp(hoverIdx ?? vEnd, 0, data.length - 1);
  const showVal = data[showIdx];
  const showX = xForIndex(showIdx);
  const showY = yForVal(showVal);

  let label;
  if (Array.isArray(labels) && labels.length === data.length) {
    const d = labels[showIdx];
    try {
      const dt = asLocalDate(d);
      label = dt.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      label = String(d);
    }
  } else {
    const rel = data.length - 1 - showIdx; // 0=latest
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
              ${Number(showVal).toFixed(2)} • {label}
            </text>
          </g>
        </>
      )}
    </svg>
  );
}

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
        style={{
          width: "min(95vw, 1000px)",
          padding: 16,
        }}
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
