// frontend/src/components/SentimentMatrix.jsx
import { useEffect, useMemo, useState } from "react";
import { fetchSentimentMatrix } from "../api";

export default function SentimentMatrix({ tickers = ["AAPL","MSFT","NVDA"], days = 90 }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const list = useMemo(() => Array.from(new Set(tickers.map(t => String(t).toUpperCase()))), [tickers]);

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        setErr("");
        const res = await fetchSentimentMatrix(list, days);
        if (ok) setRows(res?.rows || []);
      } catch (e) {
        if (ok) setErr(e?.message || "Failed to load matrix");
      }
    })();
    return () => { ok = false; };
  }, [list, days]);

  return (
    <div className="card" style={{ padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>🔗 Sentiment–Return Correlation (r)</h3>
      {err ? <div className="muted error">{err}</div> : null}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Ticker</th><th className="num">N</th><th className="num">r</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.ticker}>
                <td>{r.ticker}</td>
                <td className="num">{r.n}</td>
                <td className="num">{Number.isFinite(r.pearson_r) ? r.pearson_r.toFixed(3) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
