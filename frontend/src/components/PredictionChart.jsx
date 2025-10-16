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

export default function PredictionChart({ results = [] }) {
  if (!Array.isArray(results) || results.length === 0) {
    return <div className="muted">No predictions.</div>;
  }

  const horizon = Math.max(...results.map(r => (Array.isArray(r?.predictions) ? r.predictions.length : 0)), 0);
  if (horizon === 0) return <div className="muted">No predictions.</div>;

  const labels = Array.from({ length: horizon }, (_, i) => `+${i + 1}d`);

  // build one dataset per model; guard against missing arrays
  const datasets = results.flatMap((r) => {
    const preds = Array.isArray(r?.predictions) ? r.predictions : Array(horizon).fill(null);
    const confs = Array.isArray(r?.confidence) ? r.confidence : Array(horizon).fill(null);
    return [
      {
        label: `${r?.model ?? "Model"} Forecast`,
        data: preds,
        borderWidth: 2,
        fill: false,
      },
      {
        label: `${r?.model ?? "Model"} Confidence`,
        data: confs,
        type: "bar",
        backgroundColor: "rgba(0,0,0,0.1)",
      },
    ];
  });

  const data = { labels, datasets };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "top" }, title: { display: false } },
    scales: { x: { stacked: false }, y: { stacked: false } },
  };

  return (
    <div style={{ maxWidth: 700, height: 320, margin: "auto" }}>
      <Chart type="bar" data={data} options={options} />
    </div>
  );
}
