// frontend/src/components/RecommendationCard.jsx

export default function RecommendationCard({ recommendation }) {
  return (
    <div style={cardStyle}>
      <h2 style={{ marginTop: 0 }}>📈 Recommendation</h2>
      {!recommendation ? (
        <p style={muted}>N/A</p>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            Based on lowest proxy-MAPE: <strong>{recommendation.model}</strong>
          </p>
          <p style={{ margin: 0, fontSize: 18 }}>
            <strong
              style={{
                color:
                  recommendation.action === "Buy"
                    ? "#2e7d32" // green
                    : recommendation.action === "Sell"
                    ? "#c62828" // red
                    : "#9aa0a6", // grey for Hold
              }}
            >
              {recommendation.action}
            </strong>{" "}
            <span style={mutedSmall}>
              (avg change {Number(recommendation.avgChangePct).toFixed(2)}%)
            </span>
          </p>
          <p style={mutedSmall}>
            Proxy-MAPE = average |pred − last_close| / last_close
          </p>
        </>
      )}
    </div>
  );
}

const cardStyle = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
  maxWidth: 340,
};

const muted = { color: "#666", margin: 0 };
const mutedSmall = { color: "#666", margin: 0, fontSize: 12 };
