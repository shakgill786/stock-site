// frontend/src/components/SentimentScatter.jsx
import { useEffect, useState, useMemo } from "react";
import { fetchSentimentCorrelation } from "../api";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Chart } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, PointElement, Tooltip, Legend);

export default function SentimentScatter({ ticker = "AAPL", days = 120 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        setErr("");
        const res = await fetchSentimentCorrelation(ticker, days);
        if (!ok) return;
        setData(res);
      } catch (e) {
        if (!ok) return;
        setErr(e?.message || "Failed to load scatter data");
      }
    })();
    return () => { ok = false; };
  }, [ticker, days]);

  if (err) return <div className="muted error">{err}</div>;
  if (!data) return <div className="muted">Loading scatter…</div>;

  // pairs: [{date, sent, ret}]
  const points = (data.correlation?.pairs || []).map((p) => ({
    x: Number(p.sent),
    y: Number(p.ret),
    label: String(p.date),
  }));

  const chartData = {
    datasets: [
      {
        type: "scatter",
        label: "Daily sentiment vs next-day return",
        data: points,
        pointRadius: 4,
        pointHoverRadius: 5,
      },
    ],
  };

  const options = {
    responsive: true,
    plugins: {
      legend: { position: "top" },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const item = ctx.raw;
            const yPct = (Number(item?.y) * 100).toFixed(2);
            return `${item?.label}: sent ${Number(item?.x).toFixed(3)}, next-day ${yPct}%`;
          },
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: "Aggregated sentiment (VADER compound mean)" },
        min: -1, max: 1,
      },
      y: {
        title: { display: true, text: "Next-day return (fraction)" },
        ticks: { callback: (v) => `${(Number(v) * 100).toFixed(0)}%` },
      },
    },
  };

  const r = data.correlation?.pearson_r;
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>📊 Sentiment vs Next-Day Return — {ticker}</h3>
        <div className="muted">Pearson r = {Number.isFinite(r) ? r.toFixed(3) : "n/a"}</div>
      </div>
      <div style={{ height: 260 }}>
        <Chart type="scatter" data={chartData} options={options} />
      </div>
    </div>
  );
}
