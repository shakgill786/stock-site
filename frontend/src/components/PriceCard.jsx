// frontend/src/components/PriceCard.jsx
const fmtMoney = (v) => (Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : "—");
const clampPct = (v, lo = -25, hi = 25) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
};

export default function PriceCard({ quote = {} }) {
  const pctRaw = quote.display_change_pct ?? quote.change_pct;
  const pct = clampPct(pctRaw);
  const isUp = pct >= 0;

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '1rem',
      marginBottom: '1rem',
      maxWidth: 320,
      background: 'linear-gradient(180deg, var(--panel), var(--panel-2))'
    }}>
      <h2 style={{ marginTop: 0 }}>💰 Current Price {quote.ticker ? <span className="muted">({quote.ticker})</span> : null}</h2>
      <p>Last Close: {fmtMoney(quote.last_close)}</p>
      <p style={{ fontWeight: 600 }}>
        Now: {fmtMoney(quote.current_price)}{" "}
        <span style={{ color: isUp ? "var(--good)" : "var(--bad)" }}>
          {isUp ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
        </span>
      </p>
    </div>
  );
}
