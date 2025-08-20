// frontend/src/components/HotAndEarnings.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchQuote, fetchEarnings } from "../api";
import useLocalStorage from "../hooks/useLocalStorage";

const FALLBACK_TICKERS = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","NFLX","AMD",
  "JPM","V","MA","XOM","CVX","WMT","HD","PG","KO","PEP",
  "UNH","JNJ","LLY","PFE","BAC","C","GS","MS","CSCO","ORCL",
  "ADBE","CRM","QCOM","TXN","INTC","T","VZ","DIS","NKE","COST",
  "MCD","ABT","TMO","UPS","LOW","IBM","CAT","HON","BA","PYPL"
];

const fmtPct = (v) =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—";
const fmtMoney = (v) =>
  Number.isFinite(v) ? `$${Number(v).toFixed(2)}` : "—";

export default function HotAndEarnings() {
  const [watchlist] = useLocalStorage("WATCHLIST_V1", []);
  const universe = useMemo(() => {
    const wl = (watchlist || []).map((w) => String(w.symbol || "").toUpperCase());
    const dedup = Array.from(new Set([...(wl || []), ...FALLBACK_TICKERS]));
    return dedup.slice(0, 80);
  }, [watchlist]);

  const [loading, setLoading] = useState(false);
  const [gainers, setGainers] = useState([]);
  const [losers, setLosers] = useState([]);
  const [earnings, setEarnings] = useState([]);
  const [err, setErr] = useState("");

  const reqVer = useRef(0);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setErr("");
      const myVer = ++reqVer.current;

      try {
        const quotes = await Promise.all(
          universe.map(async (t) => {
            try {
              const q = await fetchQuote(t);
              const cp = Number(q?.change_pct);
              return {
                symbol: String(q?.ticker || t).toUpperCase(),
                price: Number(q?.current_price),
                last_close: Number(q?.last_close ?? NaN),
                change_pct: Number.isFinite(cp) ? cp : null,
                name: q?.name || undefined,
              };
            } catch {
              return null;
            }
          })
        );

        const clean = quotes.filter(
          (q) => q && Number.isFinite(q.price) && Number.isFinite(q.change_pct)
        );

        const topGainers = [...clean].sort((a, b) => b.change_pct - a.change_pct).slice(0, 25);
        const topLosers  = [...clean].sort((a, b) => a.change_pct - b.change_pct).slice(0, 25);

        if (reqVer.current !== myVer) return;
        setGainers(topGainers);
        setLosers(topLosers);
      } catch (e) {
        if (reqVer.current !== myVer) return;
        setErr(e?.message || "Failed to load movers");
        setGainers([]);
        setLosers([]);
      } finally {
        if (reqVer.current === myVer) setLoading(false);
      }

      // earnings next 7 days for a subset
      const cutoff = Date.now() + 7 * 24 * 3600 * 1000;
      try {
        const pool = universe.slice(0, 80);
        const rows = await Promise.all(
          pool.map(async (t) => {
            try {
              const e = await fetchEarnings(t);
              const d = e?.next_earnings ? new Date(`${e.next_earnings}T00:00:00`) : null;
              if (d && d.getTime() <= cutoff) {
                return { symbol: t, date: e.next_earnings, name: e?.name, session: e?.session || "" };
              }
              return null;
            } catch {
              return null;
            }
          })
        );
        setEarnings(rows.filter(Boolean).slice(0, 60));
      } catch {
        /* ignore */
      }
    };

    run();
  }, [universe]);

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>🔥 Hot Stocks Today & Earnings This Week</h3>
        {loading && <span className="muted">loading…</span>}
      </div>
      {err && <div style={{ color: "salmon", marginTop: 6 }}>{err}</div>}

      {/* two equal columns that fit page width */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        <MoversTable title="Top 25 Gainers" rows={gainers} />
        <MoversTable title="Top 25 Losers" rows={losers} />
      </div>

      {/* earnings table full width */}
      <div className="card" style={{ marginTop: 16 }}>
        <h4 style={{ marginTop: 0 }}>Earnings (This Week)</h4>
        {earnings.length ? (
          <div className="table-wrap">
            <table className="table" style={{ width: "100%", tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "28%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "36%" }} />
                <col style={{ width: "18%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ticker</th>
                  <th>Name</th>
                  <th>Session</th>
                </tr>
              </thead>
              <tbody>
                {earnings
                  .sort((a, b) => (a.date < b.date ? -1 : 1))
                  .map((r, i) => (
                    <tr key={`${r.symbol}-${i}`}>
                      <td>{r.date}</td>
                      <td>{r.symbol}</td>
                      <td>{r.name || ""}</td>
                      <td>{r.session || ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted">No upcoming earnings within 7 days for the sampled set.</div>
        )}
      </div>
    </div>
  );
}

function MoversTable({ title, rows = [] }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <h4 style={{ marginTop: 0 }}>{title}</h4>
      {rows.length ? (
        <div className="table-wrap">
          <table
            className="table"
            style={{ width: "100%", tableLayout: "fixed" }}
          >
            {/* Columns: Symbol • Price (tight), $ Change, % Change, Name */}
            <colgroup>
              <col style={{ width: "36%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ whiteSpace: "nowrap" }}>Symbol • Price</th>
                <th>$ Change</th>
                <th>% Change</th>
                <th>Name</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const price = Number(r.price);
                const pct = Number(r.change_pct);
                const lastClose = Number(r.last_close);
                // Prefer exact $ change when last_close is present; otherwise derive from pct
                const dollarChange = Number.isFinite(price) && Number.isFinite(lastClose)
                  ? price - lastClose
                  : (Number.isFinite(price) && Number.isFinite(pct) ? (pct / 100) * price : NaN);
                const isUp = Number.isFinite(dollarChange) ? dollarChange >= 0 : pct >= 0;

                return (
                  <tr key={`${r.symbol}-${i}`}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {/* ultra-tight inline row */}
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "baseline",
                          gap: 6, // keep this small to reduce space between symbol & price
                        }}
                      >
                        <strong>{r.symbol}</strong>
                        <span>{fmtMoney(price)}</span>
                      </span>
                    </td>
                    <td style={{ color: isUp ? "#2e7d32" : "#c62828" }}>
                      {Number.isFinite(dollarChange)
                        ? `${dollarChange >= 0 ? "+" : ""}${fmtMoney(Math.abs(dollarChange)).slice(1)}`
                        : "—"}
                    </td>
                    <td style={{ color: pct >= 0 ? "#2e7d32" : "#c62828" }}>
                      {fmtPct(pct)}
                    </td>
                    <td
                      className="muted"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                      }}
                      title={r.name || ""}
                    >
                      {r.name || ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted">No data.</div>
      )}
    </div>
  );
}
