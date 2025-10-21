// frontend/src/components/SentimentScatter.jsx
import { useEffect, useState, useMemo } from "react";
import { fetchSentimentCorrelation } from "../api";
import {
  Chart as ChartJS, LinearScale, PointElement, Tooltip, Legend,
} from "chart.js";
import { Chart } from "react-chartjs-2";

ChartJS.register(LinearScale, PointElement, Tooltip, Legend);

export default function SentimentScatter({ ticker, days = 120, height = 260 }) {
  const [rows, setRows] = useState([]);
  const [corr, setCorr] = useState({ same_day: null, next_day: null });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let dead = false;
    const run = async () => {
      setLoading(true); setErr("");
      try {
        const r = await fetchSentimentCorrelation(ticker, { days });
        if (!dead) {
          setRows(Array.isArray(r?.rows) ? r.rows : []);
          setCorr(r?.corr || {});
        }
      } catch (e) {
        setErr(String(e?.message || e));
      } finally {
        if (!dead) setLoading(false);
      }
    };
    run();
    return () => { dead = true; };
  }, [ticker, days]);

  const points = useMemo(() => {
    return rows
      .filter(r => typeof r.next_day_return_pct === "number" && typeof r.sentiment === "number")
      .map(r => ({ x: r.sentiment, y: r.next_day_return_pct, d: r.date }));
  }, [rows]);

  if (err) return <div className="muted error">{err}</div>;

  const data = {
    datasets: [
      {
        label: "Sentiment vs Next-Day Return",
        data: points,
        pointRadius: 3,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      tooltip: {
        callbacks: {
          label: ctx => {
            const p = ctx.raw;
            return `${p.d}: sentiment ${p.x.toFixed(2)}, next-day ${p.y.toFixed(2)}%`;
          },
        },
      },
      legend: { display: false },
    },
    scales: {
      x: { title: { display: true, text: "Daily mean sentiment (compound)" }, min: -1, max: 1 },
      y: { title: { display: true, text: "Next-day return (%)" } },
    },
  };

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ marginTop: 0 }}>📈 Sentiment vs Next-Day Return — {ticker}</h3>
        <div className="muted" style={{ fontSize: 12 }}>
          r (same): {corr?.same_day?.toFixed?.(2) ?? "—"} • r (next): {corr?.next_day?.toFixed?.(2) ?? "—"}
        </div>
      </div>
      {loading ? <div className="muted">Loading…</div> : <div style={{ height }}><Chart type="scatter" data={data} options={options} /></div>}
    </div>
  );
}
