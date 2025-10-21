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

export default function SentimentOverlay({ ticker = "AAPL", days = 120 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        setErr("");
        const res = await fetchSentimentCorrelation(ticker, days);
        if (ok) setData(res);
      } catch (e) {
        if (ok) setErr(e?.message || "Failed to load sentiment correlation");
      }
    })();
    return () => { ok = false; };
  }, [ticker, days]);

  if (err) return <div className="muted error">{err}</div>;
  if (!data) return <div className="muted">Loading sentiment…</div>;

  // Align by date; sentiment daily has {date, mean}, closes_dates are ISO day strings
  const sentMap = new Map((data.daily || []).map(r => [String(r.date), Number(r.mean)]));
  const labels = (data.closes_dates || []).map(d => String(d).slice(0, 10));
  const price = (data.closes || []).map(Number);
  const sent = labels.map(d => sentMap.has(d) ? sentMap.get(d) : null);

  // Simple normalization for chart: z-score-ish for overlay
  const norm = (arr) => {
    const xs = arr.filter((v) => Number.isFinite(v));
    if (!xs.length) return arr.map(() => null);
    const m = xs.reduce((a,b)=>a+b,0)/xs.length;
    const s = Math.sqrt(xs.reduce((a,b)=>a+(b-m)*(b-m),0)/xs.length) || 1;
    return arr.map(v => Number.isFinite(v) ? (v - m) / s : null);
  };
  const normPrice = norm(price);
  const normSent = norm(sent);

  const datasets = [
    {
      type: "line",
      label: "Price (normalized)",
      data: normPrice,
      borderWidth: 2,
      yAxisID: "y",
    },
    {
      type: "bar",
      label: "Sentiment (normalized)",
      data: normSent,
      yAxisID: "y1",
      backgroundColor: "rgba(150,170,255,0.25)",
      borderWidth: 0,
    },
  ];

  const r = data.correlation?.pearson_r;
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>📰 Sentiment vs Price — {ticker}</h3>
        <div className="muted">Pearson r = {Number.isFinite(r) ? r.toFixed(3) : "n/a"}</div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Chart
          type="bar"
          data={{ labels, datasets }}
          options={{
            responsive: true,
            interaction: { mode: "index", intersect: false },
            scales: {
              y: { position: "left", grid: { display: false } },
              y1: { position: "right", grid: { display: false } },
            },
            plugins: { legend: { position: "bottom" } },
          }}
        />
      </div>
    </div>
  );
}
