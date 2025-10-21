// frontend/src/components/CorrelationMatrixCard.jsx
import { useEffect, useMemo, useState } from "react";
import { fetchDailySentiment } from "../api";

/** Very light “matrix”: correlation between sentiment series for tickers */
export default function CorrelationMatrixCard({ tickers = [], window_days = 60 }) {
  const [series, setSeries] = useState({}); // {SYM: [{date, mean_compound}]}
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let dead = false;
    const run = async () => {
      setLoading(true);
      const out = {};
      for (const t of tickers.slice(0, 10)) {
        try {
          const r = await fetchDailySentiment(t, { window_days });
          out[t] = Array.isArray(r?.rows) ? r.rows : [];
        } catch {}
      }
      if (!dead) { setSeries(out); setLoading(false); }
    };
    run();
    return () => { dead = true; };
  }, [tickers, window_days]);

  const syms = Object.keys(series);
  const dates = useMemo(() => {
    const s = new Set();
    syms.forEach(sym => (series[sym] || []).forEach(r => s.add(r.date)));
    return Array.from(s).sort();
  }, [series, syms]);

  const mat = useMemo(() => {
    const val = (sym) => {
      const m = new Map();
      (series[sym] || []).forEach(r => m.set(r.date, r.mean_compound));
      return dates.map(d => (m.has(d) ? m.get(d) : 0));
    };
    const pearson = (a, b) => {
      const n = Math.min(a.length, b.length);
      if (n < 3) return null;
      let ax=0, ay=0;
      for (let i=0;i<n;i++){ ax+=a[i]; ay+=b[i]; }
      ax/=n; ay/=n;
      let num=0, dx=0, dy=0;
      for (let i=0;i<n;i++){ const vx=a[i]-ax, vy=b[i]-ay; num+=vx*vy; dx+=vx*vx; dy+=vy*vy; }
      if (dx===0||dy===0) return null;
      return num/Math.sqrt(dx*dy);
    };
    const rows = syms.map(s1 => syms.map(s2 => {
      const r = pearson(val(s1), val(s2));
      return r == null ? "—" : r.toFixed(2);
    }));
    return rows;
  }, [dates, syms, series]);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>🧮 Sentiment Correlation (watchlist)</h3>
      {loading ? <div className="muted">Loading…</div> : syms.length ? (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                {syms.map(s => <th key={s}>{s}</th>)}
              </tr>
            </thead>
            <tbody>
              {mat.map((row, i) => (
                <tr key={syms[i]}>
                  <td style={{ fontWeight: 700 }}>{syms[i]}</td>
                  {row.map((v, j) => (
                    <td key={syms[i] + "-" + syms[j]}
                        style={{ color: typeof v === "string" && v!=="—" ? (parseFloat(v) >= 0 ? "#2e7d32" : "#c62828") : "inherit" }}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="muted">Add tickers to see a matrix.</div>}
    </div>
  );
}
