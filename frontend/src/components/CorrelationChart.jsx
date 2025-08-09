// frontend/src/components/CorrelationChart.jsx

const ORDER = ["SPY", "XLK", "XLF", "VIX", "TNX"];

export default function CorrelationChart({ corr }) {
  return (
    <div style={cardStyle}>
      <h2 style={{ marginTop: 0 }}>🔗 Correlation vs Price</h2>
      {!corr ? (
        <p style={muted}>N/A</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Symbol</th>
              <th style={thStyle}>Corr</th>
              <th style={thStyle}>Interpretation</th>
            </tr>
          </thead>
          <tbody>
            {ORDER.filter((k) => k in corr).map((k) => {
              const v = corr[k];
              const pos = v >= 0;
              return (
                <tr key={k}>
                  <td style={tdStyle}>{k}</td>
                  <td style={tdStyle}>{v.toFixed(2)}</td>
                  <td style={tdStyle}>
                    {pos ? "🟢 Positive" : "🔴 Negative"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: "1rem",
  minWidth: 300,
  flex: "1 1 420px",
};

const thStyle = {
  borderBottom: "1px solid #eee",
  textAlign: "left",
  padding: "6px 8px",
  background: "#f8f8f8",
};

const tdStyle = {
  borderBottom: "1px solid #f1f1f1",
  padding: "6px 8px",
};

const muted = { color: "#666", margin: 0 };
