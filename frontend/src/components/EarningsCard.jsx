// frontend/src/components/EarningsCard.jsx
export default function EarningsCard({ earnings }) {
    return (
      <div style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: "1rem",
        marginBottom: "1rem",
        maxWidth: 300
      }}>
        <h2>🗓️ Next Earnings Date</h2>
        <p>{earnings.ticker}: {earnings.nextEarningsDate}</p>
      </div>
    );
  }
  