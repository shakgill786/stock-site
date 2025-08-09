// frontend/src/components/EarningsCard.jsx

export default function EarningsCard({ earnings }) {
  const isObj = earnings && typeof earnings === "object";
  const ticker = (isObj && earnings.ticker) || "";
  const date = isObj && earnings.nextEarningsDate;

  return (
    <div style={cardStyle}>
      <h2 style={{ marginTop: 0 }}>🗓️ Next Earnings {ticker ? `(${ticker})` : ""}</h2>
      {isObj ? (
        <p style={date ? normal : muted}>{date || "N/A"}</p>
      ) : (
        <p style={muted}>N/A</p>
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

const normal = { margin: 0 };
const muted = { color: "#666", margin: 0 };
