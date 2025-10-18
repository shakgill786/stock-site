// frontend/src/components/MarketCard.jsx

// Strict parsing + normalization for market tiles
const EPS = 1e-6;
const toNum = (v) => {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim().replace(/[%,$]/g, "");
    if (!s) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};
const isNum = (v) => Number.isFinite(toNum(v));
const nearZero = (v) => Math.abs(toNum(v)) < EPS;

const clampPct = (v, lo = -60, hi = 60) => {
  const n = toNum(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : NaN;
};
const fmtMoney = (v) => (isNum(v) ? `$${toNum(v).toFixed(2)}` : "—");
const fmtPct = (v) => (isNum(v) ? `${toNum(v) >= 0 ? "+" : ""}${toNum(v).toFixed(2)}%` : "—");

// derive a sane % change for one tile worth of data
function derivePct(data = {}) {
  // 1) explicit normalized value from backend if available
  if (isNum(data.display_change_pct)) return clampPct(data.display_change_pct);

  // 2) provider % as-is (with clamp)
  if (isNum(data.change_pct)) return clampPct(data.change_pct);

  // 3) compute from price vs last_close, else vs open
  const price = toNum(
    data.extended_price ??
      data.postmarket_price ??
      data.after_hours_price ??
      data.premarket_price ??
      data.current_price ??
      data.price
  );
  const lastClose = toNum(
    data.last_close ??
      data.previous_close ??
      data.prev_close ??
      data.regularMarketPreviousClose
  );
  const open = toNum(data.open);

  if (isNum(price) && isNum(lastClose) && !nearZero(lastClose)) {
    return clampPct(((price - lastClose) / lastClose) * 100);
  }
  if (isNum(price) && isNum(open) && !nearZero(open)) {
    return clampPct(((price - open) / open) * 100);
  }
  return NaN;
}

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
        {entries.map(([sym, raw]) => {
          // normalize each tile
          const price =
            toNum(
              raw.extended_price ??
                raw.postmarket_price ??
                raw.after_hours_price ??
                raw.premarket_price ??
                raw.current_price ??
                raw.price
            );
          const pct = derivePct(raw);
          const hasPct = isNum(pct);
          const up = hasPct ? toNum(pct) >= 0 : null;

          return (
            <div
              key={sym}
              className="mk-tile"
              role="group"
              aria-label={`${sym} ${hasPct ? `${up ? "up" : "down"} ${Math.abs(toNum(pct)).toFixed(2)} percent` : ""}`}
            >
              <div className="mk-head">
                <div className="mk-sym">{sym}</div>
                {hasPct ? (
                  <span
                    className={`mk-pill ${up ? "mk-pill--up" : "mk-pill--down"}`}
                    title={`${up ? "Up" : "Down"} ${Math.abs(toNum(pct)).toFixed(2)}%`}
                    aria-label={`${up ? "Up" : "Down"} ${Math.abs(toNum(pct)).toFixed(2)} percent`}
                  >
                    {up ? "▲" : "▼"} {Math.abs(toNum(pct)).toFixed(2)}%
                  </span>
                ) : (
                  <span className="mk-pill">—</span>
                )}
              </div>
              <div className="mk-price">
                {fmtMoney(price)}
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
