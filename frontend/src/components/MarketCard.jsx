// frontend/src/components/MarketCard.jsx

export default function MarketCard({ market }) {
  const entries = market ? Object.entries(market) : [];

  if (!entries.length) {
    return (
      <div>
        <h3 style={{ marginTop: 0 }}>📊 Market Snapshot</h3>
        <p className="muted" style={{ margin: 0 }}>N/A</p>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>📊 Market Snapshot</h3>

      <div className="mk-grid">
        {entries.map(([sym, data]) => {
          const price = Number(data?.current_price);
          const pct = Number(data?.change_pct);
          const hasPct = Number.isFinite(pct);
          const up = hasPct ? pct >= 0 : null;

          return (
            <div key={sym} className="mk-tile" role="group" aria-label={`${sym} ${hasPct ? `${up ? "up" : "down"} ${Math.abs(pct).toFixed(2)} percent` : ""}`}>
              <div className="mk-head">
                <div className="mk-sym">{sym}</div>
                {hasPct ? (
                  <span
                    className={`mk-pill ${up ? "mk-pill--up" : "mk-pill--down"}`}
                    title={`${up ? "Up" : "Down"} ${Math.abs(pct).toFixed(2)}%`}
                    aria-label={`${up ? "Up" : "Down"} ${Math.abs(pct).toFixed(2)} percent`}
                  >
                    {up ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
                  </span>
                ) : (
                  <span className="mk-pill">—</span>
                )}
              </div>
              <div className="mk-price">
                {Number.isFinite(price) ? `$${price.toFixed(2)}` : "—"}
              </div>
            </div>
          );
        })}
      </div>

      <style>{`
        .mk-grid{
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        }
        .mk-tile{
          background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 10px 12px;
          box-shadow: var(--shadow);
          display: flex; flex-direction: column; gap: 6px;
          min-width: 0;
        }
        .mk-head{ display: flex; align-items: center; justify-content: space-between; gap: 8px }
        .mk-sym{ font-weight: 700; letter-spacing: .2px; overflow: hidden; text-overflow: ellipsis }
        .mk-price{ font-variant-numeric: tabular-nums; font-size: 1.05rem }

        .mk-pill{
          display: inline-flex; align-items: center; gap: 6px;
          padding: 2px 8px; border-radius: 999px;
          border: 1px solid var(--border);
          background: #0f1430; color: var(--muted);
          font-size: 12px; font-weight: 700;
        }
        .mk-pill--up{ color: var(--good); border-color: rgba(52,199,89,.35) }
        .mk-pill--down{ color: var(--bad); border-color: rgba(255,59,48,.35) }

        @media (max-width: 720px){
          .mk-grid{ gap: 8px }
          .mk-price{ font-size: 1rem }
        }
      `}</style>
    </div>
  );
}
