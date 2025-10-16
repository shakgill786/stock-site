// frontend/src/components/RecommendationCard.jsx
export default function RecommendationCard({ recommendation }) {
  if (!recommendation) {
    return (
      <div>
        <h3 style={{ marginTop: 0 }}>📈 Recommendation</h3>
        <p className="muted" style={{ margin: 0 }}>N/A</p>
      </div>
    );
  }

  const action = String(recommendation.action || "Hold");
  const model = recommendation.model || "—";
  const avgNum = Number(recommendation.avgChangePct);
  const avg = Number.isFinite(avgNum) ? avgNum : 0;

  const pillClass =
    action === "Buy" ? "pill pill--good" :
    action === "Sell" ? "pill pill--bad" :
    "pill pill--neutral";

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>📈 Recommendation</h3>

      <div className="rec-row">
        <span className={pillClass} aria-label={`Action: ${action}`}>{action}</span>
        <span className="rec-sub">
          avg change&nbsp;<strong>{avg.toFixed(2)}%</strong>
        </span>
      </div>

      <div className="muted" style={{ marginTop: 6 }}>
        Based on lowest proxy-MAPE: <strong>{model}</strong>
      </div>

      <div className="muted rec-footnote">
        Proxy-MAPE = average |pred − last_close| / last_close
      </div>

      <style>{`
        .rec-row{
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          margin-top: 4px;
        }
        .rec-sub{ color: var(--muted); font-size: 0.95rem }
        .rec-footnote{ font-size: 12px; margin-top: 6px }

        .pill{
          display: inline-block;
          padding: 4px 10px;
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: .2px;
          border: 1px solid var(--border);
          background: linear-gradient(180deg, #101630, #0c1126);
        }
        .pill--good{
          color: var(--good);
          border-color: rgba(52,199,89,.35);
          box-shadow: 0 0 0 2px rgba(52,199,89,.12) inset;
        }
        .pill--bad{
          color: var(--bad);
          border-color: rgba(255,59,48,.35);
          box-shadow: 0 0 0 2px rgba(255,59,48,.12) inset;
        }
        .pill--neutral{
          color: var(--muted);
        }
      `}</style>
    </div>
  );
}
