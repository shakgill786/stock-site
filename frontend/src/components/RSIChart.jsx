// frontend/src/components/RSIChart.jsx

export default function RSIChart({ rsi }) {
    return (
      <div style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>📈 RSI (14)</h2>
        {!rsi?.values?.length ? (
          <p style={muted}>N/A</p>
        ) : (
          <>
            <p style={mutedSmall}>Last: {rsi.values[rsi.values.length - 1].toFixed(2)}</p>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {rsi.values.slice(-30).map((v, i) => (
                <span
                  key={i}
                  title={v.toFixed(2)}
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 24,
                    background:
                      v >= 70 ? "#c62828" : v <= 30 ? "#2e7d32" : "#90a4ae",
                    opacity: 0.9,
                  }}
                />
              ))}
            </div>
            <p style={mutedSmall}>Red=Overbought (≥70), Green=Oversold (≤30)</p>
          </>
        )}
      </div>
    );
  }
  
  const cardStyle = {
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: "1rem",
    minWidth: 300,
    flex: "0 1 320px",
  };
  
  const muted = { color: "#666", margin: 0 };
  const mutedSmall = { color: "#666", margin: "6px 0 0 0", fontSize: 12 };
  