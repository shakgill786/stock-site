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

// Register once
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

// fixed palette — prevents “black line” on dark backgrounds
const COLORS = {
  price: "#9ec1ff",
  sentimentBar: "rgba(150,170,255,0.35)",
};

export default function SentimentOverlay({ ticker = "AAPL", days = 120 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // Load once per (ticker, days) — no conditional hooks anywhere
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const res = await fetchSentimentCorrelation(ticker, days);
        if (!alive) return;
        setData(res || null);
      } catch (e) {
        if (!alive) return;
        setErr(e?.message || "Failed to load sentiment correlation");
        setData(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ticker, days]);

  // Build chart payload in a single memo (always called)
  const chartStuff = useMemo(() => {
    if (!data) {
      return { ok: false, labels: [], datasets: [], r: null };
    }

    // Align by date; sentiment daily has {date, mean}, closes_dates are ISO day strings
    const sentMap = new Map((data.daily || []).map((r) => [String(r.date).slice(0, 10), Number(r.mean)]));
    const rawLabels = Array.isArray(data.closes_dates) ? data.closes_dates : [];
    const labels = rawLabels.map((d) => String(d).slice(0, 10));

    const price = (Array.isArray(data.closes) ? data.closes : []).map((v) => (Number.isFinite(+v) ? +v : null));
    const sent = labels.map((d) => {
      const v = sentMap.get(d);
      return Number.isFinite(+v) ? +v : null;
    });

    if (!labels.length || !price.length) {
      return { ok: false, labels: [], datasets: [], r: data.correlation?.pearson_r ?? null };
    }

    // Normalize both to z-ish scores so they overlay meaningfully
    const norm = (arr) => {
      const xs = arr.filter((v) => Number.isFinite(v));
      if (!xs.length) return arr.map(() => null);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const stdev = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length) || 1;
      return arr.map((v) => (Number.isFinite(v) ? (v - mean) / stdev : null));
    };

    const normPrice = norm(price);
    const normSent = norm(sent);

    const datasets = [
      {
        type: "line",
        label: "Price (normalized)",
        data: normPrice,
        borderColor: COLORS.price,      // explicit
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        spanGaps: true,
        tension: 0.25,
        yAxisID: "y",
      },
      {
        type: "bar",
        label: "Sentiment (normalized)",
        data: normSent,
        backgroundColor: COLORS.sentimentBar,
        borderWidth: 0,
        yAxisID: "y1",
      },
    ];

    return {
      ok: true,
      labels,
      datasets,
      r: Number.isFinite(+data?.correlation?.pearson_r) ? +data.correlation.pearson_r : null,
    };
  }, [data]);

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>📰 Sentiment vs Price — {ticker}</h3>
        <div className="muted">Pearson r = {Number.isFinite(chartStuff.r) ? chartStuff.r.toFixed(3) : "n/a"}</div>
      </div>

      {loading && <div className="muted">Loading sentiment…</div>}
      {!!err && !loading && <div className="muted error">{err}</div>}

      {chartStuff.ok ? (
        <div style={{ marginTop: 8 }}>
          <Chart
            type="bar"
            data={{ labels: chartStuff.labels, datasets: chartStuff.datasets }}
            options={{
              responsive: true,
              interaction: { mode: "index", intersect: false },
              scales: {
                y: { position: "left", grid: { display: false } },
                y1: { position: "right", grid: { display: false } },
              },
              plugins: { legend: { position: "bottom" } },
              animation: { duration: 250 },
            }}
          />
        </div>
      ) : (
        !loading &&
        !err && <div className="muted" style={{ marginTop: 8 }}>No sentiment/price data to display.</div>
      )}
    </div>
  );
}
