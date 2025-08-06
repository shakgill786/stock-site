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
    BarElement,    // ← for confidence bars
    Title,
    Tooltip,
    Legend
  );
  
  export default function PredictionChart({ results }) {
    // results: [ { model, predictions, confidence }, … ]
    const labels = results[0].predictions.map((_, i) => `+${i + 1}d`);
  
    // build one dataset per model:
    const datasets = results.flatMap((r, idx) => [
      {
        label: `${r.model} Forecast`,
        data: r.predictions,
        borderWidth: 2,
        fill: false,
      },
      {
        label: `${r.model} Confidence`,
        data: r.confidence,
        type: "bar",
        backgroundColor: "rgba(0,0,0,0.1)",
      },
    ]);
  
    const data = { labels, datasets };
  
    return (
      <div style={{ maxWidth: 700, margin: "auto" }}>
        <Chart type="bar" data={data} />
      </div>
    );
  }
  