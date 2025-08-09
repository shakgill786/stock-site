// frontend/src/components/DividendCard.jsx

export default function DividendCard({ dividends }) {
  // Defensive helpers
  const isObj = dividends && typeof dividends === "object";
  const available = isObj && dividends.available === true;
  const reason = isObj && dividends.reason;
  const amt = isObj && dividends.lastDividendAmount;
  const exd = isObj && dividends.exDividendDate;
  const ticker = (isObj && dividends.ticker) || "";

  const reasonLabel =
    reason === "plan_blocked"
      ? "Provider plan limit"
      : reason === "no_data"
      ? "No dividend history"
      : reason === "incomplete"
      ? "Incomplete data"
      : reason === "fetch_error"
      ? "Fetch error"
      : reason === "exception"
      ? "Unexpected error"
      : null;

  return (
    <div style={cardStyle}>
      <h2 style={{ marginTop: 0 }}>💧 Dividend Info {ticker ? `(${ticker})` : ""}</h2>

      {!isObj ? (
        <p style={muted}>N/A</p>
      ) : available ? (
        <>
          <p>
            <strong>Last Dividend:</strong>{" "}
            {amt !== undefined && amt !== null ? `$${amt}` : "N/A"}
          </p>
          <p>
            <strong>Ex-Dividend Date:</strong> {exd || "N/A"}
          </p>
        </>
      ) : (
        <p style={muted}>
          N/A{reasonLabel ? ` — ${reasonLabel}` : ""}
        </p>
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
