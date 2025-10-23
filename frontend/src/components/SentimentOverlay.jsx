// frontend/src/components/SentimentOverlay.jsx
import { useEffect, useMemo, useState } from "react";
import { fetchSentimentCorrelation } from "../api";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Chart } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

// Theme-safe color tokens (explicit to avoid "black" fallback)
const colors = {
  priceLine: "var(--line-actual, #8fb9ff)",       // blue
  sentBars: "rgba(150,170,255,0.35)",             // translucent blue
  axis: "rgba(220,225,255,0.70)",
  grid: "rgba(255,255,255,0.08)",
  legend: "rgba(230,235,255,0.85)",
};

// Set global defaults so tooltips/labels aren’t black on dark BG
ChartJS.defaults.color = colors.legend;
ChartJS.defaults.borderColor = colors.grid;

export default function SentimentOverlay({ ticker = "AAPL", days = 120 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        setErr("");
        setLoading(true);
        const res = await fetchSentimentCorrelation(ticker, days, { signal: ac.signal });
        if (!ac.signal.aborted) setData(res);
      } catch (e) {
        if (!ac.signal.aborted) setErr(e?.message || "Failed to load sentiment correlation");
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [ticker, days]);

  if (err) return <div className="muted error">{err}</div>;
  if (!data) return <div className="muted">Loading sentiment…</div>;

  // Align by date; sentiment daily has {date, mean}, closes_dates are ISO day strings
  const sentMap = useMemo(
    () => new Map((data.daily || []).map((r) => [String(r.date).slice(0, 10), Number(r.mean)])),
    [data.daily]
  );
  const labels = useMemo(() => (data.closes_dates || []).map((d) => String(d).slice(0, 10)), [data.closes_dates]);
  const price = useMemo(() => (data.closes || []).map((n) => Number(n)), [data.closes]);
  const sent = useMemo(() => labels.map((d) => (sentMap.has(d) ? sentMap.get(d) : null)), [labels, sentMap]);

  // Simple normalization for overlay (z-score-ish). Handles all-null safely.
  const norm = (arr) => {
    const xs = arr.filter((v) => Number.isFinite(v));
    if (!xs.length) return arr.map(() => null);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length) || 1;
    return arr.map((v) => (Number.isFinite(v) ? (v - m) / s : null));
  };

  const normPrice = useMemo(() => norm(price), [price]);
  const normSent = useMemo(() => norm(sent), [sent]);

  const hasAnySent = useMemo(() => normSent.some((v) => Number.isFinite(v)), [normSent]);

  const r = data?.correlation?.pearson_r;
  const rText = Number.isFinite(r) ? r.toFixed(3) : "n/a";

  const datasets = useMemo(() => {
    const base = [
      {
        type: "line",
        label: "Price (normalized)",
        data: normPrice,
        borderColor: colors.priceLine,     // <- explicit (fixes “black line”)
        backgroundColor: colors.priceLine,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25,
        spanGaps: true,
        yAxisID: "y",
      },
    ];
    if (hasAnySent) {
      base.push({
        type: "bar",
        label: "Sentiment (normalized)",
        data: normSent,
        backgroundColor: colors.sentBars, // <- explicit
        borderWidth: 0,
        yAxisID: "y1",
      });
    }
    return base;
  }, [normPrice, normSent, hasAnySent]);

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: colors.axis, maxRotation: 0 },
          grid: { color: colors.grid },
        },
        y: {
          position: "left",
          ticks: { color: colors.axis },
          grid: { color: colors.grid },
        },
        y1: {
          position: "right",
          ticks: { color: colors.axis },
          grid: { display: false },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: colors.legend },
        },
        tooltip: {
          intersect: false,
        },
      },
      animation: { duration: 250 },
    }),
    []
  );

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>📰 Sentiment vs Price — {ticker}</h3>
        <div className="muted">
          {loading ? "Loading…" : `Pearson r = ${rText}`}
          {!hasAnySent ? " • no recent news sentiment" : ""}
        </div>
      </div>

      <div style={{ marginTop: 8, height: 280 }}>
        <Chart type="bar" data={{ labels, datasets }} options={options} />
      </div>
    </div>
  );
}
