// frontend/src/components/EarningsCard.jsx

function fmtDateHuman(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return String(iso);
  }
}

function daysUntil(iso) {
  try {
    const today = new Date();
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
    // zero out time
    today.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / (1000 * 60 * 60 * 24));
    return diff;
  } catch {
    return null;
  }
}

export default function EarningsCard({ earnings }) {
  const isObj = earnings && typeof earnings === "object";
  const ticker = (isObj && earnings.ticker) || "";
  const dateISO = isObj && (earnings.nextEarningsDate || earnings.date);
  const session = isObj && (earnings.session || earnings.when || ""); // e.g., BMO / AMC / —
  const pretty = fmtDateHuman(dateISO);
  const dleft = dateISO ? daysUntil(dateISO) : null;

  // badge color for session
  const pillClass =
    String(session).toUpperCase() === "BMO"
      ? "pill pill--bmo"
      : String(session).toUpperCase() === "AMC"
      ? "pill pill--amc"
      : "pill";

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>
        🗓️ Next Earnings {ticker ? <span className="muted">({ticker})</span> : null}
      </h3>

      {!isObj ? (
        <p className="muted" style={{ margin: 0 }}>N/A</p>
      ) : (
        <>
          <div className="earn-row">
            <div className="earn-date">
              <div className="earn-date-main">{pretty}</div>
              <div className="earn-date-sub muted">
                {dleft != null
                  ? dleft > 0
                    ? `${dleft} day${dleft === 1 ? "" : "s"} left`
                    : dleft === 0
                    ? "today"
                    : `${Math.abs(dleft)} day${Math.abs(dleft) === 1 ? "" : "s"} ago`
                  : "—"}
              </div>
            </div>
            {session ? <span className={pillClass}>{String(session).toUpperCase()}</span> : null}
          </div>

          <style>{`
            .earn-row{
              display: flex; align-items: center; justify-content: space-between; gap: 10px;
              flex-wrap: wrap;
            }
            .earn-date-main{ font-weight: 700; letter-spacing: .2px }
            .earn-date-sub{ font-size: 12px; margin-top: 2px }

            .pill{
              display: inline-block;
              padding: 4px 10px;
              border-radius: 999px;
              font-weight: 700;
              letter-spacing: .2px;
              border: 1px solid var(--border);
              background: linear-gradient(180deg, #101630, #0c1126);
              color: var(--muted);
            }
            .pill--bmo{
              color: #64b5f6;
              border-color: rgba(100,181,246,.35);
              box-shadow: 0 0 0 2px rgba(100,181,246,.10) inset;
            }
            .pill--amc{
              color: #ef9a9a;
              border-color: rgba(239,154,154,.35);
              box-shadow: 0 0 0 2px rgba(239,154,154,.10) inset;
            }

            @media (max-width: 720px){
              .earn-row{ gap: 8px }
            }
          `}</style>
        </>
      )}
    </div>
  );
}
