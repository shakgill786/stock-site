// frontend/src/components/HotAndEarnings.jsx
// Movers (Gainers/Losers) + Earnings Week + Top Buys
// - Broader hydration (always first N + missing/clamped/near-zero)
// - Recompute Δ$ / Δ% from price vs last_close when possible
// - Local sign classification (no cross-contamination)

import { useEffect, useMemo, useState } from "react";
import { API_BASE, fetchMovers, fetchEarningsWeek, fetchQuote, fetchCloses } from "../api";
import TopBuysCard from "./TopBuysCard";

const EPS = 1e-6;
const MAX_SENSIBLE_PCT = 200;       // guardrail vs junk data
const HYDRATE_BATCH = 6;
const HYDRATE_ALWAYS_FIRST = 40;    // always hydrate at least this many per list
const NEAR_ZERO_PCT = 0.05;         // rows with |pct| < this are rehydrated

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
  isNum(v) ? `${toNum(v) >= 0 ? "+" : "-"}$${Math.abs(toNum(v)).toFixed(2)}` : "—";
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

const looksClamped = (pct) => isNum(pct) && Math.abs(toNum(pct)) >= 24.9;

function firstNum(obj, keys) {
  for (const k of keys) {
    if (obj && k in obj) {
      const v = obj[k];
      if (isNum(v)) return toNum(v);
    }
  }
  return undefined;
}
const signMismatch = (a, b) =>
  isNum(a) && isNum(b) && !nearZero(a) && !nearZero(b) &&
  Math.sign(toNum(a)) !== Math.sign(toNum(b));

/** Normalize any row into a consistent shape.  IMPORTANT: returns last_close too. */
function normalizeRow(row) {
  const symbol = String(row?.symbol || row?.ticker || row?.Symbol || row?.Ticker || "").toUpperCase();

  const price = firstNum(row, [
    "price","last","last_price","current","close","Close",
    "extended_price","ext_price","postmarket_price","postMarketPrice",
    "after_hours_price","afterHoursPrice","premarket_price","preMarketPrice",
  ]);

  let change = firstNum(row, ["change","chg","delta","Change","extended_change","after_hours_change","postmarket_change"]);
  let change_pct = firstNum(row, [
    "change_pct","change_percent","percent_change","pct_change","pct","ChangePercent",
    "changePct","percentChange","extended_change_pct","after_hours_change_pct","postmarket_change_pct",
  ]);

  const prevClose = firstNum(row, [
    "prev_close","previous_close","previousClose","priorClose",
    "last_close","PrevClose","PreviousClose","close_prev","yesterday_close",
  ]);
  const open = firstNum(row, ["open","Open"]);

  // Fix clamped % if we can
  if (looksClamped(change_pct) && isNum(price) && isNum(change)) {
    const base = toNum(price) - toNum(change);
    if (isNum(base) && !nearZero(base)) {
      const p2 = (toNum(change) / base) * 100;
      if (isNum(p2) && Math.abs(p2) < 24.9) change_pct = p2;
    }
  }

  // Prefer price vs prevClose
  if (isNum(price) && isNum(prevClose) && !nearZero(prevClose)) {
    const derivedChange = toNum(price) - toNum(prevClose);
    const derivedPct = (derivedChange / toNum(prevClose)) * 100;
    if (!isNum(change)) change = derivedChange;
    if (!isNum(change_pct) || looksClamped(change_pct)) change_pct = derivedPct;
  }

  // Fallback to open if needed
  if (!(isNum(change) && isNum(change_pct)) && isNum(price) && isNum(open) && !nearZero(open)) {
    const intraday = toNum(price) - toNum(open);
    const intradayPct = (intraday / toNum(open)) * 100;
    if (!isNum(change)) change = intraday;
    if (!isNum(change_pct) || looksClamped(change_pct)) change_pct = intradayPct;
  }

  // If only one of change / pct is present, derive the other
  if (!isNum(change) && isNum(change_pct)) {
    const base = isNum(prevClose) ? prevClose : price;
    if (isNum(base) && !nearZero(base)) change = (toNum(change_pct) / 100) * toNum(base);
  }
  if (!isNum(change_pct) && isNum(change)) {
    const base = isNum(prevClose) ? prevClose : (isNum(price) ? toNum(price) - toNum(change) : NaN);
    const p2 = isNum(base) && !nearZero(base) ? (toNum(change) / toNum(base)) * 100 : NaN;
    if (isNum(p2)) change_pct = p2;
  }

  // Fractional pct (e.g., 0.0123 = 1.23%)
  if (isNum(change_pct) && Math.abs(toNum(change_pct)) <= 2.5 && isNum(price) && isNum(prevClose) && !nearZero(prevClose)) {
    const recomputed = ((toNum(price) - toNum(prevClose)) / toNum(prevClose)) * 100;
    const asPercent = toNum(change_pct);
    const asPercentTimes100 = asPercent * 100;
    const err1 = Math.abs(recomputed - asPercent);
    const err2 = Math.abs(recomputed - asPercentTimes100);
    change_pct = err2 < err1 ? asPercentTimes100 : asPercent;
  }

  if (signMismatch(change, change_pct)) {
    const base = isNum(prevClose) ? prevClose : (isNum(price) ? toNum(price) - toNum(change) : NaN);
    if (isNum(base) && !nearZero(base)) change = (toNum(change_pct) / 100) * toNum(base);
  }

  if (isNum(change) && nearZero(change)) change = 0;
  if (isNum(change_pct) && nearZero(change_pct)) change_pct = 0;

  if (isNum(change_pct) && Math.abs(toNum(change_pct)) > MAX_SENSIBLE_PCT) {
    change_pct = NaN;
  }

  return { symbol, price, change, change_pct, last_close: isNum(prevClose) ? toNum(prevClose) : undefined, name: row?.name ?? "" };
}

function pickFromQuote(q) {
  const lastClose = toNum(firstNum(q, [
    "last_close","previous_close","previousClose","prev_close","regularMarketPreviousClose"
  ]));

  const extPrice = firstNum(q, [
    "extended_price","ext_price","postmarket_price","postMarketPrice",
    "after_hours_price","afterHoursPrice","premarket_price","preMarketPrice",
  ]);
  const curPrice = toNum(firstNum(q, [
    "current_price","price","last","last_price","regularMarketPrice"
  ]));
  const price = isNum(extPrice) ? extPrice : curPrice;

  let change = firstNum(q, [
    "extended_change","ext_change","postmarket_change","after_hours_change","premarket_change",
    "change","regularMarketChange",
  ]);
  let change_pct = firstNum(q, [
    "extended_change_pct","ext_change_pct","postmarket_change_pct","after_hours_change_pct","premarket_change_pct",
    "change_pct","percent_change","regularMarketChangePercent",
  ]);

  if ((!isNum(change)) && isNum(price) && isNum(lastClose)) {
    change = toNum(price) - toNum(lastClose);
  }
  if ((!isNum(change_pct) || looksClamped(change_pct)) && isNum(change) && isNum(lastClose) && !nearZero(lastClose)) {
    change_pct = (toNum(change) / toNum(lastClose)) * 100;
  }

  return normalizeRow({
    symbol: q?.ticker || q?.symbol || "",
    price,
    last_close: lastClose,
    change,
    change_pct,
  });
}

function pickLastTwoCloses(resp) {
  const ds = Array.isArray(resp?.dates) ? resp.dates : [];
  const cs = Array.isArray(resp?.closes) ? resp.closes : [];
  const rows = [];
  for (let i = 0; i < Math.min(ds.length, cs.length); i++) {
    const d = String(ds[i]).slice(0, 10);
    const t = Date.parse(d);
    const c = toNum(cs[i]);
    if (Number.isFinite(t) && isNum(c)) rows.push({ t, d, c });
  }
  if (!rows.length) return null;

  rows.sort((a, b) => a.t - b.t);
  const uniq = [];
  for (let i = 0; i < rows.length; i++) {
    if (!uniq.length || uniq[uniq.length - 1].d !== rows[i].d) uniq.push(rows[i]);
    else uniq[uniq.length - 1] = rows[i];
  }
  if (uniq.length < 2) return null;

  const last = uniq[uniq.length - 1];
  let j = uniq.length - 2;
  while (j >= 0 && uniq[j].d === last.d) j--;
  if (j < 0) return null;
  const prev = uniq[j];

  if (!isNum(prev.c) || !isNum(last.c) || nearZero(prev.c)) return null;

  const ch = toNum(last.c) - toNum(prev.c);
  const pct = (ch / toNum(prev.c)) * 100;

  if (!Number.isFinite(pct) || Math.abs(pct) > MAX_SENSIBLE_PCT) return null;

  return { prevClose: prev.c, lastClose: last.c, change: ch, change_pct: pct };
}

/** Ensure a row has solid deltas by hydrating via quote (then EOD closes). */
async function hydrateOneRow(row) {
  try {
    const q = await fetchQuote(row.symbol);
    const picked = pickFromQuote(q || {});
    let merged = normalizeRow({
      ...row,
      price: isNum(row.price) ? row.price : picked.price,
      change: isNum(row.change) && !nearZero(row.change) ? row.change : picked.change,
      change_pct:
        (isNum(row.change_pct) && !nearZero(row.change_pct) && !looksClamped(row.change_pct))
          ? row.change_pct
          : picked.change_pct,
      last_close: firstNum(q, ["last_close", "previous_close", "previousClose", "prev_close", "regularMarketPreviousClose"]),
    });

    const ok =
      (isNum(merged.change) && !nearZero(merged.change)) ||
      (isNum(merged.change_pct) && !nearZero(merged.change_pct) && !looksClamped(merged.change_pct));

    if (ok) return merged;

    try {
      const closeResp = await fetchCloses(row.symbol, 10);
      const eod = pickLastTwoCloses(closeResp);
      if (eod) {
        return normalizeRow({
          ...row,
          price: isNum(merged.price) ? merged.price : eod.lastClose,
          last_close: eod.prevClose,
          change: eod.change,
          change_pct: eod.change_pct,
        });
      }
    } catch { /* ignore */ }

    return merged;
  } catch {
    return row;
  }
}

/** Hydrate a list: always first N, plus rows with missing/clamped/near-zero deltas. */
async function hydrateRows(rows) {
  const base = rows.map((r) => ({ ...r }));
  const need = [];

  const markNeed = (r, i) => {
    const smallPct = isNum(r.change_pct) && Math.abs(toNum(r.change_pct)) < NEAR_ZERO_PCT;
    const missing =
      (!(isNum(r.change) && !nearZero(r.change)) &&
       !(isNum(r.change_pct) && !nearZero(r.change_pct))) ||
      looksClamped(r.change_pct) ||
      smallPct;
    if (missing) need.push({ i, sym: r.symbol });
  };

  // Always include the first HYDRATE_ALWAYS_FIRST rows
  for (let i = 0; i < Math.min(base.length, HYDRATE_ALWAYS_FIRST); i++) {
    need.push({ i, sym: base[i].symbol });
  }
  // Also include any that look missing/clamped/near-zero
  base.forEach(markNeed);

  // Deduplicate indices
  const uniqIdx = [...new Set(need.map((x) => x.i))];

  for (let k = 0; k < uniqIdx.length; k += HYDRATE_BATCH) {
    const slice = uniqIdx.slice(k, k + HYDRATE_BATCH);
    await Promise.all(
      slice.map(async (i) => {
        base[i] = await hydrateOneRow(base[i]);
      })
    );
  }

  return base;
}

function rowSign(r) {
  if (isNum(r.change_pct) && !nearZero(r.change_pct)) return Math.sign(toNum(r.change_pct));
  if (isNum(r.change) && !nearZero(r.change)) return Math.sign(toNum(r.change));
  if (isNum(r.price) && isNum(r.last_close) && !nearZero(r.last_close)) {
    const ch = toNum(r.price) - toNum(r.last_close);
    if (!nearZero(ch)) return Math.sign(ch);
  }
  return 0;
}

function dedupeBest(rows) {
  const score = (v) =>
    (isNum(v.price) ? 1 : 0) +
    (isNum(v.last_close) ? 1 : 0) +
    (isNum(v.change) ? 1 : 0) +
    (isNum(v.change_pct) ? 1 : 0);
  const map = new Map();
  for (const r0 of rows) {
    const r = normalizeRow(r0);
    if (!r.symbol) continue;
    const ex = map.get(r.symbol);
    if (!ex || score(r) > score(ex)) map.set(r.symbol, r);
  }
  return [...map.values()];
}

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

function MoversCard({ title, rows = [], loading, error, onPick, fetchedFrom, kind = "gainers" }) {
  const [minPrice, setMinPrice] = useState(1);
  const [sortKey, setSortKey] = useState("change_pct");
  const [sortDir, setSortDir] = useState(kind === "losers" ? "asc" : "desc");

  const filtered = useMemo(() => {
    const lim = Number.isFinite(minPrice) ? Number(minPrice) : 0;
    return (rows || []).filter((x) => {
      // Keep if we have a price and either:
      // - a usable change/percent, or
      // - we can compute from last_close
      if (!isNum(x.price) || toNum(x.price) < lim) return false;

      const usableDelta =
        (isNum(x.change) && !nearZero(x.change)) ||
        (isNum(x.change_pct) && !nearZero(x.change_pct));

      if (usableDelta) return true;

      if (isNum(x.last_close) && !nearZero(x.last_close)) {
        const ch = toNum(x.price) - toNum(x.last_close);
        if (!nearZero(ch)) return true;
      }
      return false;
    });
  }, [rows, minPrice]);

  const sorted = useMemo(() => {
    const key = sortKey;
    const arr = filtered.map((r) => {
      // final recompute display deltas when possible
      if (isNum(r.price) && isNum(r.last_close) && !nearZero(r.last_close)) {
        const ch = toNum(r.price) - toNum(r.last_close);
        const pct = (ch / toNum(r.last_close)) * 100;
        return { ...r, change: ch, change_pct: pct };
      }
      return r;
    });

    arr.sort((a, b) => {
      const va = isNum(a?.[key]) ? toNum(a[key]) : (sortDir === "desc" ? -Infinity : Infinity);
      const vb = isNum(b?.[key]) ? toNum(b[key]) : (sortDir === "desc" ? -Infinity : Infinity);
      const cmp = vb - va;
      return sortDir === "desc" ? cmp : -cmp;
    });
    return arr.slice(0, 25);
  }, [filtered, sortKey, sortDir]);

  const onHeaderClick = (key) => {
    if (sortKey !== key) setSortKey(key);
    else setSortDir((d) => (d === "desc" ? "asc" : "desc"));
  };

  return (
    <Card
      title={title}
      right={
        <div className="he-controls">
          {fetchedFrom && (
            <span className="he-source">
              source: {fetchedFrom}{fetchedFrom.includes("alpha") ? " (hydrated)" : ""}
            </span>
          )}
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
                const { symbol: sym, price, change, change_pct } = r;
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

function FragmentBlock({ children }) { return <>{children}</>; }

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
    setLoadingMovers(true);
    setErrMovers("");
    try {
      const mv = await fetchMovers();

      // Normalize both lists
      const g0 = (Array.isArray(mv?.gainers) ? mv.gainers : []).map(normalizeRow);
      const l0 = (Array.isArray(mv?.losers) ? mv.losers : []).map(normalizeRow);

      // Always hydrate a chunk + any missing/clamped/near-zero
      const [gHydrated, lHydrated] = await Promise.all([hydrateRows(g0), hydrateRows(l0)]);

      // Merge + dedupe by symbol
      const merged = dedupeBest([...gHydrated, ...lHydrated]).map((r) => {
        // Final consistency: if we have last_close, recompute from it
        if (isNum(r.price) && isNum(r.last_close) && !nearZero(r.last_close)) {
          const ch = toNum(r.price) - toNum(r.last_close);
          const pct = (ch / toNum(r.last_close)) * 100;
          return normalizeRow({ ...r, change: ch, change_pct: pct });
        }
        return r;
      });

      // Classify by sign so gainers/losers never mix
      const onlyValid = (x) => {
        if (!isNum(x.price)) return false;
        if ((isNum(x.change) && !nearZero(x.change)) || (isNum(x.change_pct) && !nearZero(x.change_pct))) return true;
        if (isNum(x.last_close) && !nearZero(x.last_close)) {
          const ch = toNum(x.price) - toNum(x.last_close);
          return !nearZero(ch);
        }
        return false;
      };

      const pos = merged.filter((r) => onlyValid(r) && rowSign(r) > 0);
      const neg = merged.filter((r) => onlyValid(r) && rowSign(r) < 0);

      // Debug counts (visible in console)
      console.debug("[movers] source:", mv?.source, "| gainers:", g0.length, "→", pos.length, "| losers:", l0.length, "→", neg.length);

      setGainers(pos);
      setLosers(neg);
      setMoverSource(mv?.source ? `${mv.source}` : "");
    } catch (e) {
      setErrMovers(e?.message || "Failed to load movers.");
      setGainers([]);
      setLosers([]);
      setMoverSource("");
    } finally {
      setLoadingMovers(false);
    }

    setLoadingEarnings(true);
    setErrEarnings("");
    try {
      let wk = await fetchEarningsWeek();
      if (!wk && typeof wk !== "object") wk = {};
      if (!Array.isArray(wk.items) && wk?.error?.includes?.("405")) {
        throw new Error("405");
      }
      const items = Array.isArray(wk?.items) ? wk.items : [];
      if (!items.length) {
        try {
          const res = await fetch(`${API_BASE}/earnings_week/`, {
            headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
            cache: "no-store",
            method: "GET",
          });
          if (res.ok) {
            const alt = await res.json();
            if (Array.isArray(alt?.items)) {
              setEarnings(alt.items.slice(0, 500));
              if (!alt.items.length && alt?.error) setErrEarnings(alt.error);
              return;
            }
          }
        } catch {/* ignore */}
      }
      setEarnings(items.slice(0, 500));
      if (!items.length && wk?.error) setErrEarnings(wk.error);
    } catch (e) {
      setErrEarnings(e?.message === "405" ? "405 – Method Not Allowed (retrying with trailing slash failed)" :
        (e?.message || "Failed to load earnings."));
      setEarnings([]);
    } finally {
      setLoadingEarnings(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const topBuyCandidates = useMemo(() => {
    const fromMovers = [...gainers, ...losers].map((r) => r.symbol);
    const uniq = Array.from(new Set(fromMovers));
    if (uniq.length >= 40) return uniq;
    return Array.from(
      new Set(
        uniq.concat([
          "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","JPM","V","MA","LLY","UNH","HD","PEP","KO",
        ])
      )
    );
  }, [gainers, losers]);

  return (
    <div className="he-grid">
      <div className="he-toolbar">
        <button className="btn ghost he-refresh" onClick={refresh} title="Refresh sections">↻ Refresh</button>
      </div>

      <MoversCard
        title="Top 25 Gainers"
        rows={gainers}
        loading={loadingMovers}
        error={errMovers}
        onPick={pick}
        fetchedFrom={moverSource}
        kind="gainers"
      />
      <MoversCard
        title="Top 25 Losers"
        rows={losers}
        loading={loadingMovers}
        error={errMovers}
        onPick={pick}
        fetchedFrom={moverSource}
        kind="losers"
      />

      <TopBuysCard
        title="Top 25 Buys (model)"
        candidates={topBuyCandidates}
        onPick={pick}
        max={25}
      />

      <EarningsCard
        items={earnings}
        loading={loadingEarnings}
        error={errEarnings}
      />

      <style>{`
        .he-grid { display: grid; grid-template-columns: 1fr; gap: 12px; width: 100%; margin-top: 8px; }
        @media (min-width: 980px) {
          .he-grid { grid-template-columns: 1fr 1fr; }
          .he-grid > :nth-last-child(1) { grid-column: 1 / -1; }
        }

        .he-toolbar {
          grid-column: 1 / -1;
          display: flex;
          justify-content: flex-end;
          align-items: center;
        }
        .he-toolbar .btn { width: auto !important; min-width: unset; display: inline-flex; align-items: center; }
        .he-refresh { padding: 6px 10px; font-size: 12px; }

        .he-card {
          padding: 12px; overflow: hidden; border-radius: 14px;
          background: radial-gradient(120% 120% at 100% 0%, rgba(160,170,255,0.06), rgba(25,28,45,0.6) 55%, rgba(17,20,35,0.8));
          border: 1px solid rgba(255,255,255,0.07); box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        }
        .he-card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
        .he-head-right, .he-controls { display: flex; gap: 8px; align-items: center; }
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
