// frontend/src/components/PredictionChart.jsx
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
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
  BarElement, // for confidence bars
  Title,
  Tooltip,
  Legend
);

// explicit palette so we never fall back to pure black on dark backgrounds
const palette = [
  "#8fb9ff", // blue
  "#ffd166", // amber
  "#90ee90", // green
  "#ff7f7f", // red
  "#b892ff", // purple
  "#66e0ff", // cyan
];
const barTint = "rgba(150,170,255,0.35)";

export default function PredictionChart({ results = [] }) {
  if (!Array.isArray(results) || results.length === 0) {
    return <div className="muted">No predictions.</div>;
  }

  const horizon = Math.max(
    ...results.map((r) => (Array.isArray(r?.predictions) ? r.predictions.length : 0)),
    0
  );
  if (horizon === 0) return <div className="muted">No predictions.</div>;

  const labels = Array.from({ length: horizon }, (_, i) => `+${i + 1}d`);

  // one line dataset per model + optional confidence bars (on y1)
  const datasets = results.flatMap((r, idx) => {
    const color = palette[idx % palette.length];
    const preds = Array.isArray(r?.predictions)
      ? r.predictions.map((n) => (Number.isFinite(+n) ? +n : null))
      : Array(horizon).fill(null);
    const confs = Array.isArray(r?.confidence)
      ? r.confidence.map((n) => (Number.isFinite(+n) ? +n : null))
      : null;

    const modelName = r?.model ?? "Model";
    const out = [
      {
        label: `${modelName} Forecast`,
        type: "line",
        data: preds,
        borderWidth: 2,
        borderColor: color,          // <- fixes “black line”
        backgroundColor: color,
        pointRadius: 2,
        spanGaps: true,
        tension: 0.25,
        yAxisID: "y",
      },
    ];

    if (confs && confs.some((v) => Number.isFinite(v))) {
      out.push({
        label: `${modelName} Confidence`,
        type: "bar",
        data: confs,
        backgroundColor: barTint,    // <- explicit tint
        borderWidth: 0,
        yAxisID: "y1",
      });
    }
    return out;
  });

  const data = { labels, datasets };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { position: "top", labels: { color: "rgba(230,235,255,0.9)" } },
      title: { display: false },
      tooltip: { mode: "index", intersect: false },
    },
    scales: {
      x: { ticks: { color: "rgba(220,225,255,0.8)" }, grid: { color: "rgba(255,255,255,0.08)" } },
      y: { ticks: { color: "rgba(220,225,255,0.8)" }, grid: { color: "rgba(255,255,255,0.08)" } },
      y1: {
        position: "right",
        min: 0,
        max: 1, // confidence is 0..1
        ticks: { color: "rgba(220,225,255,0.8)" },
        grid: { display: false },
      },
    },
    animation: { duration: 250 },
  };

  return (
    <div style={{ maxWidth: 700, height: 320, margin: "auto" }}>
      <Chart type="bar" data={data} options={options} />
    </div>
  );
}
