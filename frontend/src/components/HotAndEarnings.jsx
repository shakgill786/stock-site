// frontend/src/components/HotAndEarnings.jsx
// Polished Movers (Gainers/Losers) + Earnings Week
// - sticky headers, scrollable tables
// - sort + min price filter for movers
// - source badge (alphavantage | fallback-local)
// - grouped earnings by date with sticky separators
// - accessible, compact, and click-to-load tickers

import { useEffect, useMemo, useState } from "react";
import { fetchMovers, fetchEarningsWeek } from "../api";

/* ---------- helpers & formatters ---------- */
const num = (v) => (typeof v === "number" ? v : Number(v));
const isNum = (v) => Number.isFinite(num(v));

const fmtMoney = (v) => (isNum(v) ? `$${num(v).toFixed(2)}` : "—");
const fmtSignMoney = (v) =>
  isNum(v) ? `${num(v) >= 0 ? "+" : ""}$${Math.abs(num(v)).toFixed(2)}` : "—";
const fmtPct = (v) =>
  isNum(v) ? `${num(v) >= 0 ? "+" : ""}${num(v).toFixed(2)}%` : "—";

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

const SESSION_BADGE = (s) => {
  const S = String(s || "").toUpperCase();
  if (S === "BMO")
    return { text: "BMO", bg: "rgba(25,118,210,0.15)", fg: "#64b5f6", br: "rgba(100,181,246,0.35)" };
  if (S === "AMC")
    return { text: "AMC", bg: "rgba(244,67,54,0.15)", fg: "#ef9a9a", br: "rgba(239,154,154,0.35)" };
  return { text: S || "—", bg: "rgba(255,255,255,0.08)", fg: "#bbb", br: "rgba(255,255,255,0.12)" };
};

/* ---------- shared UI shells ---------- */
function Card({ title, right, children }) {
  return (
    <div className="he-card">
      <div className="he-card-head">
        <h3>{title}</h3>
        <div className="he-head-right">{right}</div>
      </div>
      {children}
    </div>
  );
}

/* ---------- Movers Table (with filter + sort) ---------- */
function MoversCard({ title, rows = [], loading, error, onPick, fetchedFrom }) {
  // price filter
  const [minPrice, setMinPrice] = useState(1); // 0 | 1 | 5
  // sort: key in {"change","change_pct"} and dir in {"desc","asc"}
  const [sortKey, setSortKey] = useState("change_pct");
  const [sortDir, setSortDir] = useState("desc");

  const filtered = useMemo(() => {
    const r = Array.isArray(rows) ? rows : [];
    const lim = Number(minPrice) || 0;
    return r.filter((x) => (isNum(x?.price) ? num(x.price) >= lim : false));
  }, [rows, minPrice]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const key = sortKey;
    arr.sort((a, b) => {
      const va = isNum(a?.[key]) ? num(a[key]) : -Infinity;
      const vb = isNum(b?.[key]) ? num(b[key]) : -Infinity;
      const cmp = vb - va;
      return sortDir === "desc" ? cmp : -cmp;
    });
    return arr.slice(0, 25);
  }, [filtered, sortKey, sortDir]);

  const onHeaderClick = (key) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("desc");
    } else {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    }
  };

  return (
    <Card
      title={title}
      right={
        <div className="he-controls">
          {fetchedFrom && <span className="he-source">source: {fetchedFrom}</span>}
          <select
            value={String(minPrice)}
            onChange={(e) => setMinPrice(Number(e.target.value))}
            className="btn ghost"
            title="Filter by minimum price"
          >
            <option value="0">All prices</option>
            <option value="1">≥ $1</option>
            <option value="5">≥ $5</option>
          </select>
          {loading ? <span className="muted">Loading…</span> : null}
        </div>
      }
    >
      {error ? (
        <div className="muted error">{error}</div>
      ) : !sorted.length ? (
        <div className="muted">No data.</div>
      ) : (
        <div className="he-scroll">
          <table className="he-table">
            <colgroup>
              <col style={{ width: "10%" }} /> {/* # */}
              <col style={{ width: "28%" }} /> {/* symbol */}
              <col style={{ width: "22%" }} /> {/* price */}
              <col style={{ width: "20%" }} /> {/* $ chg */}
              <col style={{ width: "20%" }} /> {/* % chg */}
            </colgroup>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Symbol</th>
                <th className="num">Price</th>
                <th
                  className="num th-click"
                  onClick={() => onHeaderClick("change")}
                  title="Sort by $ change"
                >
                  $ Change {sortKey === "change" ? (sortDir === "desc" ? "▾" : "▴") : ""}
                </th>
                <th
                  className="num th-click"
                  onClick={() => onHeaderClick("change_pct")}
                  title="Sort by % change"
                >
                  % Change {sortKey === "change_pct" ? (sortDir === "desc" ? "▾" : "▴") : ""}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const sym = String(r?.symbol || r?.ticker || `#${i}`).toUpperCase();
                const price = num(r?.price);
                const chg = num(r?.change);
                const pct = num(r?.change_pct);
                const up = isNum(chg) ? chg >= 0 : pct >= 0;
                const top = i < 3; // highlight top 3
                return (
                  <tr key={`${sym}-${i}`} className={top ? "he-toprow" : ""}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <button
                        type="button"
                        className="ticker-link"
                        onClick={() =>
                          onPick?.(sym) ??
                          window.dispatchEvent(new CustomEvent("ticker:set", { detail: sym }))
                        }
                        title={`Load ${sym}`}
                      >
                        {sym}
                      </button>
                    </td>
                    <td className="num">{fmtMoney(price)}</td>
                    <td className={`num ${up ? "pos" : "neg"}`}>{fmtSignMoney(chg)}</td>
                    <td className={`num ${pct >= 0 ? "pos" : "neg"}`}>{fmtPct(pct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ---------- Earnings (grouped by date, sticky headers) ---------- */
function EarningsCard({ items = [], loading, error, onPick }) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const list = Array.isArray(items) ? items : [];
    const needle = q.trim().toUpperCase();
    if (!needle) return list;
    return list.filter((r) => String(r.symbol || "").toUpperCase().includes(needle));
  }, [items, q]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const row of filtered) {
      const d = row?.date || "";
      if (!d) continue;
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(row);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rows]) =>
        [date, rows.sort((a, b) => (a.symbol || "").localeCompare(b.symbol || ""))]
      );
  }, [filtered]);

  return (
    <Card
      title="Earnings (This Week)"
      right={
        <div className="he-controls">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter ticker…"
            className="btn ghost"
            style={{ minWidth: 120 }}
          />
          {loading ? <span className="muted">Loading…</span> : null}
        </div>
      }
    >
      {error ? (
        <div className="muted error">{error}</div>
      ) : !groups.length ? (
        <div className="muted">No earnings found.</div>
      ) : (
        <div className="he-scroll">
          <table className="he-table">
            <colgroup>
              <col style={{ width: "35%" }} />
              <col style={{ width: "35%" }} />
              <col style={{ width: "30%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Date</th>
                <th style={{ textAlign: "center" }}>Ticker</th>
                <th style={{ textAlign: "center" }}>Session</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([date, rows]) => {
                return (
                  <FragmentBlock key={date}>
                    <tr className="he-group-row">
                      <td colSpan={3} style={{ fontWeight: 700 }}>
                        {fmtDateHuman(date)}
                      </td>
                    </tr>
                    {rows.map((r, i) => {
                      const badge = SESSION_BADGE(r.session);
                      const sym = String(r.symbol || "").toUpperCase();
                      return (
                        <tr key={`${date}-${sym}-${i}`}>
                          <td className="muted">{fmtDateHuman(date)}</td>
                          <td style={{ textAlign: "center", fontWeight: 700 }}>
                            <button
                              type="button"
                              className="ticker-link"
                              onClick={() =>
                                onPick?.(sym) ??
                                window.dispatchEvent(new CustomEvent("ticker:set", { detail: sym }))
                              }
                              title={`Load ${sym}`}
                            >
                              {sym}
                            </button>
                          </td>
                          <td style={{ textAlign: "center" }}>
                            <span
                              className="he-badge"
                              style={{
                                background: badge.bg,
                                border: `1px solid ${badge.br}`,
                                color: badge.fg,
                              }}
                            >
                              {badge.text}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </FragmentBlock>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// tiny helper to return an array of <tr> without extra DOM wrappers
function FragmentBlock({ children }) {
  return <>{children}</>;
}

/* ---------- Main component ---------- */
export default function HotAndEarnings({ onSelectTicker }) {
  const [loadingMovers, setLoadingMovers] = useState(true);
  const [loadingEarnings, setLoadingEarnings] = useState(true);
  const [errMovers, setErrMovers] = useState("");
  const [errEarnings, setErrEarnings] = useState("");
  const [gainers, setGainers] = useState([]);
  const [losers, setLosers] = useState([]);
  const [earnings, setEarnings] = useState([]);
  const [moverSource, setMoverSource] = useState(""); // "alphavantage" | "fallback-local"

  const pick = (sym) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    if (typeof onSelectTicker === "function") onSelectTicker(s);
    else window.dispatchEvent(new CustomEvent("ticker:set", { detail: s }));
  };

  const refresh = async () => {
    // Movers
    setLoadingMovers(true);
    setErrMovers("");
    try {
      const mv = await fetchMovers();
      const g = (Array.isArray(mv?.gainers) ? mv.gainers : []).filter(
        (x) => isNum(x?.price) && isNum(x?.change_pct)
      );
      const l = (Array.isArray(mv?.losers) ? mv.losers : []).filter(
        (x) => isNum(x?.price) && isNum(x?.change_pct)
      );
      setGainers(g);
      setLosers(l);
      setMoverSource(mv?.source || "");
    } catch (e) {
      setErrMovers(e?.message || "Failed to load movers.");
      setGainers([]);
      setLosers([]);
      setMoverSource("");
    } finally {
      setLoadingMovers(false);
    }

    // Earnings
    setLoadingEarnings(true);
    setErrEarnings("");
    try {
      const wk = await fetchEarningsWeek();
      const items = Array.isArray(wk?.items) ? wk.items : [];
      setEarnings(items.slice(0, 500));
      if (!items.length && wk?.error) setErrEarnings(wk.error);
    } catch (e) {
      setErrEarnings(e?.message || "Failed to load earnings.");
      setEarnings([]);
    } finally {
      setLoadingEarnings(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="he-grid">
      <div className="he-toolbar">
        <button className="btn ghost" onClick={refresh} title="Refresh sections">↻ Refresh</button>
      </div>

      <MoversCard
        title="Top 25 Gainers"
        rows={gainers}
        loading={loadingMovers}
        error={errMovers}
        onPick={pick}
        fetchedFrom={moverSource}
      />
      <MoversCard
        title="Top 25 Losers"
        rows={losers}
        loading={loadingMovers}
        error={errMovers}
        onPick={pick}
        fetchedFrom={moverSource}
      />
      <EarningsCard
        items={earnings}
        loading={loadingEarnings}
        error={errEarnings}
        onPick={pick}
      />

      {/* component-scoped styles */}
      <style>{`
        .he-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
          width: 100%;
          margin-top: 8px;
        }
        .he-toolbar {
          grid-column: 1 / -1;
          display: flex;
          justify-content: flex-end;
        }
        @media (min-width: 980px) {
          .he-grid {
            grid-template-columns: 1fr 1fr;
          }
          .he-grid > :nth-last-child(1) {
            grid-column: 1 / -1; /* Earnings spans two columns on wide screens */
          }
        }

        .he-card {
          padding: 12px;
          overflow: hidden;
          border-radius: 14px;
          background: radial-gradient(120% 120% at 100% 0%, rgba(160,170,255,0.06), rgba(25,28,45,0.6) 55%, rgba(17,20,35,0.8));
          border: 1px solid rgba(255,255,255,0.07);
          box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        }
        .he-card-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          margin-bottom: 6px;
        }
        .he-card-head h3 {
          margin: 0;
        }
        .he-head-right { display: flex; gap: 10px; align-items: center; }

        .he-controls { display: flex; gap: 8px; align-items: center; }
        .he-source { font-size: 12px; color: #a8b2ff; }

        .he-scroll {
          max-height: 420px;
          overflow: auto;
          border-radius: 12px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
        }

        .he-table {
          width: 100%;
          table-layout: fixed;
          font-size: 13px;
          border-collapse: separate;
          border-spacing: 0;
        }
        .he-table thead th {
          position: sticky; top: 0;
          background: rgba(12,14,24,0.85);
          backdrop-filter: blur(2px);
          z-index: 2;
          padding: 8px 10px;
        }
        .he-table tbody tr:nth-child(odd) {
          background: rgba(255,255,255,0.02);
        }
        .he-table td, .he-table th {
          vertical-align: middle;
          padding: 8px 10px;
        }

        .num { text-align: right; font-variant-numeric: tabular-nums; }
        .th-click { cursor: pointer; user-select: none; }
        .pos { color: #2e7d32; font-weight: 600; }
        .neg { color: #c62828; font-weight: 600; }
        .he-toprow td { background: linear-gradient(90deg, rgba(168,178,255,0.07), transparent 60%); }

        .he-group-row td {
          position: sticky; top: 28px; /* below table head */
          background: rgba(70,80,130,0.16);
          border-top: 1px solid rgba(255,255,255,0.06);
          z-index: 1;
          font-weight: 700;
        }

        .he-badge{
          display: inline-block;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 12px;
          line-height: 1.3;
        }

        .ticker-link{
          background: transparent; border: none; padding: 0; margin: 0;
          cursor: pointer; color: #a2c4ff; text-decoration: underline; text-underline-offset: 2px; font: inherit;
          font-weight: 700; letter-spacing: .2px;
        }
        .ticker-link:hover{
          color: #d6e3ff; text-shadow: 0 0 6px rgba(110,168,255,.45); text-decoration-thickness: 2px;
        }

        .muted { color: #a7adbc; }
        .muted.error { color: #ff6b6b; }
      `}</style>
    </div>
  );
}
