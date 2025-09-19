// frontend/src/components/HotAndEarnings.jsx
// Movers (Gainers/Losers) + Earnings Week
// - strict parsing (no accidental string->0 coercion)
// - derives change/% from previousClose or open
// - fixes sign mismatches (trust % and recompute $)
// - hydrates rows with missing/zero change via fetchQuote (batched)
// - sticky headers, sort + min price filter

import { useEffect, useMemo, useState } from "react";
import { fetchMovers, fetchEarningsWeek, fetchQuote } from "../api";

/* ---------- strict helpers & formatters ---------- */
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

const fmtMoney = (v) => (isNum(v) ? `$${toNum(v).toFixed(2)}` : "—");
const fmtSignMoney = (v) =>
  isNum(v) ? `${toNum(v) >= 0 ? "+" : ""}$${Math.abs(toNum(v)).toFixed(2)}` : "—";
const fmtPct = (v) =>
  isNum(v) ? `${toNum(v) >= 0 ? "+" : ""}${toNum(v).toFixed(2)}%` : "—";

const fmtDateHuman = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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

/* ---------- normalizer + derivations ---------- */
function firstNum(row, keys) {
  for (const k of keys) {
    if (k in (row || {})) {
      const v = row[k];
      if (isNum(v)) return toNum(v);
    }
  }
  return undefined;
}
const signMismatch = (a, b) =>
  isNum(a) && isNum(b) && !nearZero(a) && !nearZero(b) &&
  Math.sign(toNum(a)) !== Math.sign(toNum(b));

function normalizeRow(row) {
  const symbol = String(row?.symbol || row?.ticker || row?.Symbol || row?.Ticker || "").toUpperCase();

  // Price (last/current)
  const price = firstNum(row, ["price", "last", "last_price", "current", "close", "Close"]);

  // Change and percent (possibly wrong/placeholder)
  let change = firstNum(row, ["change", "chg", "delta", "Change"]);
  let change_pct = firstNum(row, [
    "change_pct",
    "change_percent",
    "percent_change",
    "pct_change",
    "pct",
    "ChangePercent",
    "changePct",
    "percentChange",
  ]);

  // Bases we can derive from
  const prevClose = firstNum(row, [
    "prev_close",
    "previous_close",
    "previousClose",
    "priorClose",
    "last_close",
    "PrevClose",
    "PreviousClose",
    "close_prev",
    "yesterday_close",
  ]);
  const open = firstNum(row, ["open", "Open"]);

  // Prefer deriving from prevClose when available
  if (isNum(price) && isNum(prevClose)) {
    const derivedChange = toNum(price) - toNum(prevClose);
    const derivedPct = (derivedChange / toNum(prevClose)) * 100;

    if (!isNum(change) || nearZero(change)) change = derivedChange;
    if (!isNum(change_pct) || nearZero(change_pct)) change_pct = derivedPct;
  }

  // Fallback: intraday from open
  if (!(isNum(change) && isNum(change_pct)) && isNum(price) && isNum(open) && !nearZero(open)) {
    const intraday = toNum(price) - toNum(open);
    const intradayPct = (intraday / toNum(open)) * 100;
    if (!isNum(change) || nearZero(change)) change = intraday;
    if (!isNum(change_pct) || nearZero(change_pct)) change_pct = intradayPct;
  }

  // If only pct, back-compute change using best base (prevClose > price)
  if (!isNum(change) && isNum(change_pct)) {
    const base = isNum(prevClose) ? prevClose : price;
    if (isNum(base) && !nearZero(base)) change = (toNum(change_pct) / 100) * toNum(base);
  }

  // If only $, compute pct using best base (prevClose > price)
  if (!isNum(change_pct) && isNum(change)) {
    const base = isNum(prevClose) ? prevClose : price;
    if (isNum(base) && !nearZero(base)) change_pct = (toNum(change) / toNum(base)) * 100;
  }

  // Final guard: if both exist but signs disagree, trust % and recompute $
  if (signMismatch(change, change_pct)) {
    const base = isNum(prevClose) ? prevClose : price;
    if (isNum(base) && isNum(change_pct)) change = (toNum(change_pct) / 100) * toNum(base);
  }

  // squash -0.00
  if (isNum(change) && nearZero(change)) change = 0;
  if (isNum(change_pct) && nearZero(change_pct)) change_pct = 0;

  return { symbol, price, change, change_pct, name: row?.name ?? "" };
}

/* ---------- quote hydration for missing/zero change ---------- */
const HYDRATE_BATCH = 6;

async function hydrateMissing(rows) {
  const out = rows.map((r) => ({ ...r })); // copy
  const need = out
    .map((r, i) => ({
      i,
      sym: r.symbol,
      missing:
        (!(isNum(r.change) && !nearZero(r.change)) &&
         !(isNum(r.change_pct) && !nearZero(r.change_pct))) // both missing/zero
    }))
    .filter((x) => x.missing && x.sym);

  for (let k = 0; k < need.length; k += HYDRATE_BATCH) {
    const slice = need.slice(k, k + HYDRATE_BATCH);
    await Promise.all(
      slice.map(async ({ i, sym }) => {
        try {
          const q = await fetchQuote(sym);

          const price = isNum(out[i].price) ? out[i].price : toNum(q?.current_price);
          const lastClose = toNum(q?.last_close);
          let change = isNum(q?.change) ? toNum(q.change) : NaN;
          let change_pct = isNum(q?.change_pct) ? toNum(q.change_pct) : NaN;

          // Derive from quote if needed
          if ((!isNum(change) || nearZero(change)) && isNum(price) && isNum(lastClose)) {
            change = toNum(price) - toNum(lastClose);
          }
          if ((!isNum(change_pct) || nearZero(change_pct)) && isNum(change) && isNum(lastClose) && !nearZero(lastClose)) {
            change_pct = (toNum(change) / toNum(lastClose)) * 100;
          }

          // Normalize to enforce sign consistency & formatting
          out[i] = normalizeRow({
            ...out[i],
            price,
            last_close: lastClose,
            change,
            change_pct,
          });
        } catch {
          // ignore failures; row will remain as-is
        }
      })
    );
  }

  return out;
}

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
  const [minPrice, setMinPrice] = useState(1);
  const [sortKey, setSortKey] = useState("change_pct");
  const [sortDir, setSortDir] = useState("desc");

  const normalized = useMemo(() => (Array.isArray(rows) ? rows.map(normalizeRow) : []), [rows]);

  const filtered = useMemo(() => {
    const lim = Number.isFinite(minPrice) ? Number(minPrice) : 0;
    return normalized.filter(
      (x) =>
        isNum(x.price) &&
        toNum(x.price) >= lim &&
        (isNum(x.change) || isNum(x.change_pct))
    );
  }, [normalized, minPrice]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const key = sortKey;
    arr.sort((a, b) => {
      const va = isNum(a?.[key]) ? toNum(a[key]) : -Infinity;
      const vb = isNum(b?.[key]) ? toNum(b[key]) : -Infinity;
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
              <col style={{ width: "10%" }} />
              <col style={{ width: "28%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Symbol</th>
                <th className="num th-click" onClick={() => onHeaderClick("price")}>
                  Price {sortKey === "price" ? (sortDir === "desc" ? "▾" : "▴") : ""}
                </th>
                <th className="num th-click" onClick={() => onHeaderClick("change")} title="Sort by $ change">
                  $ Change {sortKey === "change" ? (sortDir === "desc" ? "▾" : "▴") : ""}
                </th>
                <th className="num th-click" onClick={() => onHeaderClick("change_pct")} title="Sort by % change">
                  % Change {sortKey === "change_pct" ? (sortDir === "desc" ? "▾" : "▴") : ""}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const { symbol: sym, price, change, change_pct } = r; // already normalized/hydrated
                const up = isNum(change) ? toNum(change) >= 0 : isNum(change_pct) ? toNum(change_pct) >= 0 : true;
                const top = i < 3;
                return (
                  <tr key={`${sym}-${i}`} className={top ? "he-toprow" : ""}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <button
                        type="button"
                        className="ticker-link"
                        onClick={() => {
                          onPick?.(sym);
                          window.dispatchEvent(new CustomEvent("ticker:set", { detail: sym }));
                        }}
                        title={`Load ${sym}`}
                      >
                        {sym}
                      </button>
                    </td>
                    <td className="num">{fmtMoney(price)}</td>
                    <td className={`num ${up ? "pos" : "neg"}`}>{fmtSignMoney(change)}</td>
                    <td className={`num ${isNum(change_pct) && toNum(change_pct) >= 0 ? "pos" : "neg"}`}>
                      {fmtPct(change_pct)}
                    </td>
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
      .map(([date, rows]) => [date, rows.sort((a, b) => (a.symbol || "").localeCompare(b.symbol || ""))]);
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
                      <td colSpan={3} style={{ fontWeight: 700 }}>{fmtDateHuman(date)}</td>
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
                              onClick={() => {
                                onPick?.(sym);
                                window.dispatchEvent(new CustomEvent("ticker:set", { detail: sym }));
                              }}
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
  const [moverSource, setMoverSource] = useState("");

  const pick = (sym) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    if (typeof onSelectTicker === "function") onSelectTicker(s);
    window.dispatchEvent(new CustomEvent("ticker:set", { detail: s }));
  };

  const refresh = async () => {
    // Movers
    setLoadingMovers(true);
    setErrMovers("");
    try {
      const mv = await fetchMovers();

      // Normalize first
      const g0 = (Array.isArray(mv?.gainers) ? mv.gainers : []).map(normalizeRow);
      const l0 = (Array.isArray(mv?.losers) ? mv.losers : []).map(normalizeRow);

      // Hydrate rows where change/% are missing or placeholder-zero
      const [g, l] = await Promise.all([hydrateMissing(g0), hydrateMissing(l0)]);

      // Keep rows that now have price + (change or pct)
      const keep = (r) => isNum(r.price) && (isNum(r.change) || isNum(r.change_pct));

      setGainers(g.filter(keep));
      setLosers(l.filter(keep));

      const usedQuotes = g0.some((r, i) => (nearZero(r.change) && isNum(g[i]?.change)) || (nearZero(r.change_pct) && isNum(g[i]?.change_pct)))
                       || l0.some((r, i) => (nearZero(r.change) && isNum(l[i]?.change)) || (nearZero(r.change_pct) && isNum(l[i]?.change_pct)));

      setMoverSource(mv?.source ? (usedQuotes ? `${mv.source} + quotes` : mv.source) : (usedQuotes ? "quotes" : ""));
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
        .he-grid { display: grid; grid-template-columns: 1fr; gap: 12px; width: 100%; margin-top: 8px; }
        .he-toolbar { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
        @media (min-width: 980px) {
          .he-grid { grid-template-columns: 1fr 1fr; }
          .he-grid > :nth-last-child(1) { grid-column: 1 / -1; }
        }
        .he-card {
          padding: 12px; overflow: hidden; border-radius: 14px;
          background: radial-gradient(120% 120% at 100% 0%, rgba(160,170,255,0.06), rgba(25,28,45,0.6) 55%, rgba(17,20,35,0.8));
          border: 1px solid rgba(255,255,255,0.07); box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        }
        .he-card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
        .he-card-head h3 { margin: 0; }
        .he-head-right { display: flex; gap: 10px; align-items: center; }
        .he-controls { display: flex; gap: 8px; align-items: center; }
        .he-source { font-size: 12px; color: #a8b2ff; }
        .he-scroll { max-height: 420px; overflow: auto; border-radius: 12px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); }
        .he-table { width: 100%; table-layout: fixed; font-size: 13px; border-collapse: separate; border-spacing: 0; }
        .he-table thead th { position: sticky; top: 0; background: rgba(12,14,24,0.85); backdrop-filter: blur(2px); z-index: 2; padding: 8px 10px; }
        .he-table tbody tr:nth-child(odd) { background: rgba(255,255,255,0.02); }
        .he-table td, .he-table th { vertical-align: middle; padding: 8px 10px; }
        .num { text-align: right; font-variant-numeric: tabular-nums; }
        .th-click { cursor: pointer; user-select: none; }
        .pos { color: #2e7d32; font-weight: 600; }
        .neg { color: #c62828; font-weight: 600; }
        .he-toprow td { background: linear-gradient(90deg, rgba(168,178,255,0.07), transparent 60%); }
        .he-group-row td { position: sticky; top: 28px; background: rgba(70,80,130,0.16); border-top: 1px solid rgba(255,255,255,0.06); z-index: 1; font-weight: 700; }
        .he-badge{ display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; line-height: 1.3; }
        .ticker-link{ background: transparent; border: none; padding: 0; margin: 0; cursor: pointer; color: #a2c4ff; text-decoration: underline; text-underline-offset: 2px; font: inherit; font-weight: 700; letter-spacing: .2px; }
        .ticker-link:hover{ color: #d6e3ff; text-shadow: 0 0 6px rgba(110,168,255,.45); text-decoration-thickness: 2px; }
        .muted { color: #a7adbc; } .muted.error { color: #ff6b6b; }
      `}</style>
    </div>
  );
}
