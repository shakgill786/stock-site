// frontend/src/components/TopBuysCard.jsx
import { useEffect, useMemo, useState } from "react";
import { fetchQuote, fetchCloses } from "../api";

/* local helpers */
const EPS = 1e-6;
const toNum = (v) => (typeof v === "number" ? v : (typeof v === "string" ? Number(v.replace(/[%,$]/g, "").trim()) : NaN));
const isNum = (v) => Number.isFinite(toNum(v));
const nearZero = (v) => Math.abs(toNum(v)) < EPS;
const fmtMoney = (v) => (isNum(v) ? `$${toNum(v).toFixed(2)}` : "—");
const fmtScore = (v) => (isNum(v) ? `${toNum(v).toFixed(1)}` : "—");
const clampPct = (v, lo = -25, hi = 25) => {
  const n = toNum(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : NaN;
};

const firstNum = (obj, keys) => {
  for (const k of keys) if (obj && k in obj && isNum(obj[k])) return toNum(obj[k]);
  return undefined;
};

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

  // prefer display_change_pct if backend supplies it
  let change_pct = firstNum(q, [
    "display_change_pct",
    "extended_change_pct","ext_change_pct","postmarket_change_pct","after_hours_change_pct","premarket_change_pct",
    "change_pct","percent_change","regularMarketChangePercent",
  ]);

  // derive % from price vs lastClose if needed
  if ((!isNum(change_pct) || nearZero(change_pct)) && isNum(price) && isNum(lastClose) && !nearZero(lastClose)) {
    change_pct = ((toNum(price) - toNum(lastClose)) / toNum(lastClose)) * 100;
  }

  const clamped_pct = clampPct(change_pct);
  return { price, lastClose, change_pct: clamped_pct };
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
  const prev = uniq[uniq.length - 2];
  if (!isNum(prev.c) || !isNum(last.c) || nearZero(prev.c)) return null;

  const pct = ((toNum(last.c) - toNum(prev.c)) / toNum(prev.c)) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) > 25) return null;

  return { prevClose: prev.c, lastClose: last.c, change_pct: pct, rows: uniq };
}

function trendPctFromCloses(resp, daysBack = 5) {
  const picked = pickLastTwoCloses(resp);
  const rows = picked?.rows || [];
  if (rows.length < daysBack + 1) return NaN;
  const last = rows[rows.length - 1].c;
  const base = rows[rows.length - 1 - daysBack].c;
  if (!isNum(last) || !isNum(base) || nearZero(base)) return NaN;
  const pct = ((toNum(last) - toNum(base)) / toNum(base)) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) > 50) return NaN;
  return pct;
}

/* simple card shell */
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

const BATCH = 6;

export default function TopBuysCard({ title = "Top 25 Buys (model)", candidates = [], onPick, max = 25 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [minPrice, setMinPrice] = useState(1);

  const symbols = useMemo(
    () => Array.from(new Set((Array.isArray(candidates) ? candidates : []).map((s) => String(s || "").toUpperCase()))).slice(0, 80),
    [candidates]
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      const out = [];

      for (let i = 0; i < symbols.length; i += BATCH) {
        const slice = symbols.slice(i, i + BATCH);
        await Promise.all(
          slice.map(async (sym) => {
            try {
              const [q, closes] = await Promise.all([
                fetchQuote(sym).catch(() => null),
                fetchCloses(sym, 20).catch(() => null),
              ]);
              const picked = q ? pickFromQuote(q) : {};
              const eod = closes ? pickLastTwoCloses(closes) : null;
              const trend5 = closes ? trendPctFromCloses(closes, 5) : NaN;

              const parts = [];
              if (isNum(picked.change_pct)) parts.push({ w: 0.5, v: Math.max(0, toNum(picked.change_pct)) });
              if (eod && isNum(eod.change_pct)) parts.push({ w: 0.3, v: Math.max(0, toNum(eod.change_pct)) });
              if (isNum(trend5)) parts.push({ w: 0.2, v: Math.max(0, toNum(trend5)) });

              const wsum = parts.reduce((a, p) => a + p.w, 0);
              if (wsum <= 0) return;

              let score = parts.reduce((a, p) => a + p.v * (p.w / wsum), 0);
              score = Math.max(0, Math.min(100, score));

              const rating = score >= 75 ? "Strong Buy" : score >= 60 ? "Buy" : "Watch";

              out.push({
                symbol: sym,
                price: isNum(picked.price) ? picked.price : (eod?.lastClose ?? NaN),
                score,
                rating,
              });
            } catch {}
          })
        );
      }

      out.sort((a, b) => b.score - a.score);
      if (!cancelled) {
        setRows(out.slice(0, max));
        setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [symbols, max]);

  const filtered = useMemo(() => {
    const lim = Number.isFinite(minPrice) ? Number(minPrice) : 0;
    return rows.filter((r) => isNum(r.price) && toNum(r.price) >= lim);
  }, [rows, minPrice]);

  return (
    <Card
      title={title}
      right={
        <div className="he-controls">
          <span className="he-source">source: model (quotes + EOD)</span>
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
      {!filtered.length ? (
        <div className="muted">{loading ? "Loading…" : "No candidates."}</div>
      ) : (
        <div className="he-scroll">
          <table className="he-table">
            <colgroup>
              <col style={{ width: "10%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "30%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Symbol</th>
                <th className="num">Price</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={`${r.symbol}-${i}`}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="ticker-link"
                      onClick={() => {
                        onPick?.(r.symbol);
                        window.dispatchEvent(new CustomEvent("ticker:set", { detail: r.symbol }));
                      }}
                      title={`Load ${r.symbol}`}
                    >
                      {r.symbol} {r.rating !== "Watch" ? <span className="he-badge" style={{ marginLeft: 6 }}>{r.rating}</span> : null}
                    </button>
                  </td>
                  <td className="num">{fmtMoney(r.price)}</td>
                  <td className="num">{fmtScore(r.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
