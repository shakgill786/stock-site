import { useEffect, useMemo, useRef, useState } from "react";
import { fetchQuote, fetchEarnings } from "../api";
import useLocalStorage from "../hooks/useLocalStorage";

/** ======== Universe ======== */
const FALLBACK_TICKERS = [
  // Big caps + tech + banks + staples (expanded a bit)
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","NFLX","AMD",
  "JPM","V","MA","XOM","CVX","WMT","HD","PG","KO","PEP",
  "UNH","JNJ","LLY","PFE","BAC","C","GS","MS","CSCO","ORCL",
  "ADBE","CRM","QCOM","TXN","INTC","T","VZ","DIS","NKE","COST",
  "MCD","ABT","TMO","UPS","LOW","IBM","CAT","HON","BA","PYPL",
  "AMAT","MU","NOW","SHOP","PLTR","UBER","ABNB","MRNA","SQ","ROKU",
  "SNOW","ZS","CRWD","PANW","SMCI","DE","GM","F","FDX","LMT",
  "GE","MMM","MDLZ","MO","PM","BKNG","AXP","ADP","SPGI","ICE"
];
const MAX_UNIVERSE = 150; // raise to scan more tickers (watchlist takes priority)

/** ======== Formatters ======== */
const fmtPct = (v) =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—";
const fmtMoney = (v) =>
  Number.isFinite(v) ? `$${Number(v).toFixed(2)}` : "—";
const fmtDateHuman = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(`${String(iso).slice(0,10)}T00:00:00`);
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch { return iso; }
};

/** ======== Week helpers (local tz, Monday->Sunday) ======== */
function startOfISOWeek(d) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (dt.getDay() + 6) % 7; // Mon=0..Sun=6
  dt.setDate(dt.getDate() - day);
  dt.setHours(0,0,0,0);
  return dt;
}
function endOfISOWeek(d) {
  const start = startOfISOWeek(d);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23,59,59,999);
  return end;
}
function shiftWeeks(d, offset) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + offset*7);
  return copy;
}
function fmtRange(a, b) {
  const opts = { month: "short", day: "numeric" };
  const left = a.toLocaleDateString(undefined, opts);
  const right = b.toLocaleDateString(undefined, opts);
  return `${left} – ${right}`;
}

/** ======== Chips for session badge ======== */
const sessionBadge = (session) => {
  const s = String(session || "").toUpperCase();
  if (!s) return { text: "—", bg: "rgba(255,255,255,0.08)", fg: "#bbb", border: "rgba(255,255,255,0.12)" };
  if (s.includes("BEFORE") || s.includes("BMO") || s === "AM")
    return { text: "BMO", bg: "rgba(25,118,210,0.15)", fg: "#64b5f6", border: "rgba(100,181,246,0.35)" };
  if (s.includes("AFTER") || s.includes("AMC") || s === "PM")
    return { text: "AMC", bg: "rgba(244,67,54,0.15)", fg: "#ef9a9a", border: "rgba(239,154,154,0.35)" };
  return { text: s, bg: "rgba(255,255,255,0.08)", fg: "#bbb", border: "rgba(255,255,255,0.12)" };
};

export default function HotAndEarnings() {
  const [watchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [weekOffset, setWeekOffset] = useState(0); // 0=this week, -1=prev, +1=next

  // Build universe (watchlist first, then fallbacks), dedup, cap
  const universe = useMemo(() => {
    const wl = (watchlist || []).map(w => String(w.symbol || "").toUpperCase());
    const dedup = Array.from(new Set([...(wl || []), ...FALLBACK_TICKERS]));
    return dedup.slice(0, MAX_UNIVERSE);
  }, [watchlist]);

  const [loading, setLoading] = useState(false);
  const [gainers, setGainers] = useState([]);
  const [losers, setLosers] = useState([]);
  const [earnings, setEarnings] = useState([]);
  const [err, setErr] = useState("");

  const reqVer = useRef(0);

  // Compute the active week window
  const { weekStart, weekEnd } = useMemo(() => {
    const base = shiftWeeks(new Date(), weekOffset);
    return { weekStart: startOfISOWeek(base), weekEnd: endOfISOWeek(base) };
  }, [weekOffset]);

  useEffect(() => {
    const run = async () => {
      const myVer = ++reqVer.current;
      setLoading(true);
      setErr("");
      setGainers([]); setLosers([]); setEarnings([]);

      /** ---- Movers (quotes) ---- */
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
              };
            } catch { return null; }
          })
        );
        const clean = quotes.filter(q => q && Number.isFinite(q.price) && Number.isFinite(q.change_pct));
        const topGainers = [...clean].sort((a,b)=> b.change_pct - a.change_pct).slice(0, 25);
        const topLosers  = [...clean].sort((a,b)=> a.change_pct - b.change_pct).slice(0, 25);
        if (reqVer.current !== myVer) return;
        setGainers(topGainers);
        setLosers(topLosers);
      } catch (e) {
        if (reqVer.current !== myVer) return;
        setErr(e?.message || "Failed to load movers");
      }

      /** ---- Earnings in ACTIVE WEEK (Mon→Sun) ---- */
      try {
        // Batch in chunks to be gentle on the API
        const CHUNK = 30;
        const picked = [];
        for (let i = 0; i < universe.length; i += CHUNK) {
          /* eslint-disable no-await-in-loop */
          const slice = universe.slice(i, i + CHUNK);
          const rows = await Promise.all(slice.map(async (t) => {
            try {
              const e = await fetchEarnings(t);
              const dateStr = e?.nextEarningsDate; // yyyy-mm-dd (assumed)
              if (!dateStr) return null;
              // interpret as local date (00:00 local)
              const d = new Date(`${dateStr}T00:00:00`);
              if (isNaN(d.getTime())) return null;

              if (d >= weekStart && d <= weekEnd) {
                return { symbol: t, date: dateStr, when: d, session: e?.session || "" };
              }
              return null;
            } catch { return null; }
          }));
          picked.push(...rows.filter(Boolean));
        }

        // Dedupe by symbol+date just in case; sort by date then symbol
        const dedupMap = new Map();
        for (const r of picked) {
          dedupMap.set(`${r.symbol}_${r.date}`, r);
        }
        const list = Array.from(dedupMap.values()).sort((a,b) =>
          a.when.getTime() - b.when.getTime() || a.symbol.localeCompare(b.symbol)
        );

        if (reqVer.current !== myVer) return;
        setEarnings(list);
      } catch {
        /* ignore earnings errors so card still renders */
      } finally {
        if (reqVer.current === myVer) setLoading(false);
      }
    };

    run();
  }, [universe, weekStart, weekEnd]);

  const earningsSorted = earnings; // already sorted

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0 }}>🔥 Hot Stocks Today & Earnings This Week</h3>
        {loading && <span className="muted">loading…</span>}
      </div>
      {err && <div style={{ color: "salmon", marginTop: 6 }}>{err}</div>}

      {/* responsive grid: single col on small screens, 2 cols on larger */}
      <div className="hot-grid" style={{ marginTop: 12 }}>
        <MoversTable title="Top 25 Gainers" rows={gainers} />
        <MoversTable title="Top 25 Losers" rows={losers} />
      </div>

      {/* earnings: table on desktop, styled stacked cards on mobile */}
      <div className="card" style={{ marginTop: 16, overflow: "hidden" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h4 style={{ marginTop: 0 }}>
            Earnings (This Week{weekOffset !== 0 ? (weekOffset > 0 ? ` +${weekOffset}` : ` ${weekOffset}`) : ""})
            <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
              {fmtRange(weekStart, weekEnd)}
            </span>
            {!!earningsSorted.length && (
              <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>• {earningsSorted.length} companies</span>
            )}
          </h4>
          <div className="row">
            <button className="btn ghost" onClick={() => setWeekOffset(o => o - 1)} title="Previous week">‹ Prev</button>
            <button className="btn ghost" onClick={() => setWeekOffset(0)} title="This week">This</button>
            <button className="btn ghost" onClick={() => setWeekOffset(o => o + 1)} title="Next week">Next ›</button>
          </div>
        </div>

        {earningsSorted.length ? (
          <>
            {/* Desktop table */}
            <div className="earnings-table-wrap">
              <table className="table" style={{ width: "100%", tableLayout: "fixed", fontSize: 13 }}>
                <colgroup>
                  <col style={{ width: "50%" }} />
                  <col style={{ width: "25%" }} />
                  <col style={{ width: "25%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Date</th>
                    <th style={{ textAlign: "center" }}>Ticker</th>
                    <th style={{ textAlign: "center" }}>Session</th>
                  </tr>
                </thead>
                <tbody>
                  {earningsSorted.map((r, i) => {
                    const badge = sessionBadge(r.session);
                    return (
                      <tr key={`${r.symbol}-${r.date}-${i}`}>
                        <td>{fmtDateHuman(r.date)}</td>
                        <td style={{ textAlign: "center", fontWeight: 700, letterSpacing: .2 }}>{r.symbol}</td>
                        <td style={{ textAlign: "center" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: badge.bg,
                              border: `1px solid ${badge.border}`,
                              color: badge.fg,
                              fontSize: 12,
                              lineHeight: 1.3,
                            }}
                          >
                            {badge.text}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile stylish stacked list */}
            <div className="earnings-list">
              {earningsSorted.map((r, i) => {
                const badge = sessionBadge(r.session);
                return (
                  <div
                    key={`${r.symbol}-m-${r.date}-${i}`}
                    className="earnings-item"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 6,
                      padding: "10px 12px",
                      borderRadius: 12,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      marginBottom: 10,
                      alignItems: "center",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontWeight: 800, letterSpacing: 0.2, fontSize: 16 }}>{r.symbol}</span>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: badge.bg,
                            border: `1px solid ${badge.border}`,
                            color: badge.fg,
                            fontSize: 11,
                            lineHeight: 1.3,
                          }}
                          title="Session"
                        >
                          {badge.text}
                        </span>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>📅 {fmtDateHuman(r.date)}</div>
                    </div>
                    <div style={{ textAlign: "right", opacity: 0.7, fontSize: 18 }}>›</div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="muted" style={{ paddingTop: 6 }}>
            No earnings found in this week window for your current universe.
            <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>
              Tip: add more tickers to your Watchlist or raise <code>MAX_UNIVERSE</code> to scan more symbols.
            </div>
          </div>
        )}
      </div>

      {/* responsive CSS specific to this component */}
      <style>{`
        /* Grid that adapts smoothly */
        .hot-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
          width: 100%;
        }
        @media (min-width: 740px) {
          .hot-grid { grid-template-columns: repeat(2, 1fr); }
        }

        /* Earnings: show table on desktop, stacked cards on mobile */
        .earnings-table-wrap { display: none; }
        .earnings-list { display: block; }

        @media (min-width: 768px) {
          .earnings-table-wrap { display: block; }
          .earnings-list { display: none; }
        }

        /* Tighten tables on small screens to prevent overflow */
        @media (max-width: 680px) {
          .table th, .table td {
            padding: 6px 8px;
            font-size: 12px;
          }
        }
        @media (max-width: 480px) {
          .table th, .table td {
            padding: 5px 6px;
            font-size: 11.5px;
          }
        }
      `}</style>
    </div>
  );
}

function MoversTable({ title, rows = [] }) {
  return (
    <div className="card" style={{ padding: 12, overflow: "hidden" }}>
      <h4 style={{ marginTop: 0 }}>{title}</h4>

      {rows.length ? (
        <div className="table-wrap" style={{ overflowX: "hidden" }}>
          <table
            className="table"
            style={{ width: "100%", tableLayout: "fixed", fontSize: 13 }}
          >
            <colgroup>
              <col style={{ width: "25%" }} />
              <col style={{ width: "25%" }} />
              <col style={{ width: "25%" }} />
              <col style={{ width: "25%" }} />
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
                const price = Number(r.price);
                const pct = Number(r.change_pct);
                const lastClose = Number(r.last_close);

                const dollarChange =
                  Number.isFinite(price) && Number.isFinite(lastClose)
                    ? price - lastClose
                    : Number.isFinite(price) && Number.isFinite(pct)
                    ? (pct / 100) * price
                    : NaN;

                const isUp = Number.isFinite(dollarChange) ? dollarChange >= 0 : pct >= 0;

                return (
                  <tr key={`${r.symbol}-${i}`}>
                    <td><strong>{r.symbol}</strong></td>
                    <td style={{ textAlign: "center" }}>{fmtMoney(price)}</td>
                    <td style={{ textAlign: "center", color: isUp ? "#2e7d32" : "#c62828" }}>
                      {Number.isFinite(dollarChange)
                        ? `${dollarChange >= 0 ? "+" : ""}${fmtMoney(Math.abs(dollarChange)).slice(1)}`
                        : "—"}
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
      ) : (
        <div className="muted">No data.</div>
      )}
    </div>
  );
}
