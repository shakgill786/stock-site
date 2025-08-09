// frontend/src/components/MetricsList.jsx

export default function MetricsList({ metrics }) {
    if (!metrics?.length) return null;
  
    return (
      <div style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>📊 Model Metrics</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {metrics
            .slice()
            .sort((a, b) => a.mapeProxy - b.mapeProxy)
            .map((m) => (
              <li key={m.model} style={{ padding: "6px 0", borderBottom: "1px solid #eee" }}>
                <strong>{m.model}</strong> → Proxy-MAPE: {(m.mapeProxy * 100).toFixed(2)}%{" "}
                <span style={muted}>(avg Δ {m.avgChangePct.toFixed(2)}%)</span>
              </li>
            ))}
        </ul>
      </div>
    );
  }
  
  const cardStyle = {
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: "1rem",
    marginTop: 12,
    marginBottom: 12,
  };
  
  const muted = { color: "#666", fontSize: 12 };
  