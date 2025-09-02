// frontend/src/components/HotAndEarnings.jsx
// Uses backend /movers (Top gainers/losers) and /earnings_week in a single fetch each.
// No placeholders; shows proper loading/empty/error states. Tickers are clickable.

import { useEffect, useMemo, useState } from "react";
import { fetchMovers, fetchEarningsWeek } from "../api";

// -------- formatters --------
const fmtMoney = (v) =>
  Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : "—";
const fmtSignMoney = (v) =>
  Number.isFinite(Number(v))
    ? `${v >= 0 ? "+" : ""}$${Math.abs(Number(v)).toFixed(2)}`
    : "—";
const fmtPct = (v) =>
  Number.isFinite(Number(v))
    ? `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`
    : "—";
const fmtDateHuman = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
};

// -------- UI bits --------
function SectionCard({ title, right, children }) {
  return (
    <div className="card" style={{ padding: 12, overflow: "hidden" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function MoversTable({ title, rows = [], loading, error, onPick }) {
  return (
    <SectionCard
      title={title}
      right={loading ? <span className="muted">Loading…</span> : null}
    >
      {error ? (
        <div className="muted" style={{ color: "#ff6b6b" }}>{error}</div>
      ) : !rows?.length ? (
        <div className="muted">No data.</div>
      ) : (
        <div className="table-wrap">
          <table className="table" style={{ width: "100%", tableLayout: "fixed", fontSize: 13 }}>
            <colgroup>
              <col style={{ width: "28%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "24%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Symbol</th>
                <th style={{ textAlign: "center" }}>Price</th>
                <th style={{ textAlign: "center" }}>$ Change</th>
                <th style={{ textAlign: "center" }}>% Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const sym = String(r?.symbol || r?.ticker || `#${i}`).toUpperCase();
                const price = Number(r?.price);
                const chg = Number(r?.change);
                const pct = Number(r?.change_pct);
                const up = Number.isFinite(chg) ? chg >= 0 : pct >= 0;
                return (
                  <tr key={`${sym}-${i}`}>
                    <td>
                      <button
                        type="button"
                        className="ticker-link"
                        onClick={() => onPick?.(sym)}
                        title={`Load ${sym}`}
                        style={{ fontWeight: 700 }}
                      >
                        {sym}
                      </button>
                    </td>
                    <td style={{ textAlign: "center" }}>{fmtMoney(price)}</td>
                    <td style={{ textAlign: "center", color: up ? "#2e7d32" : "#c62828" }}>
                      {fmtSignMoney(chg)}
                    </td>
                    <td style={{ textAlign: "center", color: pct >= 0 ? "#2e7d32" : "#c62828" }}>
                      {fmtPct(pct)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <style>{`
        .ticker-link{
          background: transparent; border: none; padding: 0; margin: 0;
          cursor: pointer; color: #a2c4ff; text-decoration: underline; text-underline-offset: 2px; font: inherit;
        }
        .ticker-link:hover{
          color: #d6e3ff; text-shadow: 0 0 6px rgba(110,168,255,.45); text-decoration-thickness: 2px;
        }
      `}</style>
    </SectionCard>
  );
}

export default function HotAndEarnings({ onSelectTicker }) {
  const [loadingMovers, setLoadingMovers] = useState(true);
  const [loadingEarnings, setLoadingEarnings] = useState(true);
  const [errMovers, setErrMovers] = useState("");
  const [errEarnings, setErrEarnings] = useState("");
  const [gainers, setGainers] = useState([]);
  const [losers, setLosers] = useState([]);
  const [earnings, setEarnings] = useState([]);

  // single click handler
  const pick = (sym) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    if (typeof onSelectTicker === "function") onSelectTicker(s);
    else window.dispatchEvent(new CustomEvent("ticker:set", { detail: s }));
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Movers
      setLoadingMovers(true);
      setErrMovers("");
      try {
        const mv = await fetchMovers();
        if (cancelled) return;

        // sanitize arrays
        const g = (Array.isArray(mv?.gainers) ? mv.gainers : []).filter(
          (x) => Number.isFinite(Number(x?.price)) && Number.isFinite(Number(x?.change_pct))
        );
        const l = (Array.isArray(mv?.losers) ? mv.losers : []).filter(
          (x) => Number.isFinite(Number(x?.price)) && Number.isFinite(Number(x?.change_pct))
        );

        setGainers(g.slice(0, 25));
        setLosers(l.slice(0, 25));

        if (!g.length && !l.length && mv?.error) {
          setErrMovers(mv.error || "No movers returned.");
        }
      } catch (e) {
        setErrMovers(e?.message || "Failed to load movers.");
        setGainers([]);
        setLosers([]);
      } finally {
        if (!cancelled) setLoadingMovers(false);
      }

      // Earnings week
      setLoadingEarnings(true);
      setErrEarnings("");
      try {
        const wk = await fetchEarningsWeek();
        if (cancelled) return;
        const items = Array.isArray(wk?.items) ? wk.items : [];
        // basic shape: {date, symbol, name, session}
        setEarnings(items.slice(0, 400));
        if (!items.length && wk?.error) {
          setErrEarnings(wk.error);
        }
      } catch (e) {
        setErrEarnings(e?.message || "Failed to load earnings.");
        setEarnings([]);
      } finally {
        if (!cancelled) setLoadingEarnings(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const earningsByDate = useMemo(() => {
    const m = new Map();
    for (const row of earnings) {
      const k = row?.date || "";
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(row);
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rows]) => ({ date, rows: rows.sort((a, b) => (a.symbol || "").localeCompare(b.symbol || "")) }));
  }, [earnings]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8, marginBottom: 8 }}>
      <SectionCard title="🔥 Hot Stocks Today" />
      <MoversTable
        title="Top 25 Gainers"
        rows={gainers}
        loading={loadingMovers}
        error={errMovers}
        onPick={pick}
      />
      <MoversTable
        title="Top 25 Losers"
        rows={losers}
        loading={loadingMovers}
        error={errMovers}
        onPick={pick}
      />

      <SectionCard
        title="Earnings (This Week)"
        right={loadingEarnings ? <span className="muted">Loading…</span> : null}
      >
        {errEarnings ? (
          <div className="muted" style={{ color: "#ff6b6b" }}>{errEarnings}</div>
        ) : !earningsByDate.length ? (
          <div className="muted">No earnings found (check FINNHUB_API_KEY on the backend).</div>
        ) : (
          <div className="table-wrap">
            <table className="table" style={{ width: "100%", tableLayout: "fixed", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Date</th>
                  <th style={{ textAlign: "center" }}>Ticker</th>
                  <th style={{ textAlign: "center" }}>Session</th>
                </tr>
              </thead>
              <tbody>
                {earningsByDate.map(({ date, rows }) => (
                  <tr key={date}>
                    <td colSpan={3} style={{ padding: "10px 0 6px", fontWeight: 700 }}>
                      {fmtDateHuman(date)}
                    </td>
                  </tr>
                )).length ? null : null}
                {earningsByDate.flatMap(({ date, rows }) =>
                  rows.map((r, i) => (
                    <tr key={`${date}-${r.symbol}-${i}`}>
                      <td>{fmtDateHuman(date)}</td>
                      <td style={{ textAlign: "center", fontWeight: 700 }}>
                        <button
                          type="button"
                          className="ticker-link"
                          onClick={() => pick(r.symbol)}
                          title={`Load ${r.symbol}`}
                        >
                          {r.symbol}
                        </button>
                      </td>
                      <td style={{ textAlign: "center" }}>{(r.session || "—").toUpperCase()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
