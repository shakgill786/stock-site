// frontend/src/components/SentimentNewsFeed.jsx
import { useEffect, useState } from "react";
import { fetchNewsSentiment } from "../api";

function badge(score){
  if (score >= 0.3) return { cls: "pill good", text: `+${score.toFixed(2)}` };
  if (score <= -0.3) return { cls: "pill bad", text: `${score.toFixed(2)}` };
  return { cls: "pill", text: `${score.toFixed(2)}` };
}

export default function SentimentNewsFeed({ ticker = "AAPL", limit = 60 }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        setErr("");
        const res = await fetchNewsSentiment(ticker, limit);
        if (ok) setItems(res?.items || []);
      } catch (e) {
        if (ok) setErr(e?.message || "Failed to load news");
      }
    })();
    return () => { ok = false; };
  }, [ticker, limit]);

  return (
    <div className="card" style={{ padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>📰 Recent Headlines — {ticker}</h3>
      {err ? <div className="muted error">{err}</div> : null}
      <div style={{ maxHeight: 360, overflow: "auto", marginTop: 6 }}>
        {items.map((it, i) => {
          const s = Number(it.sentiment || 0);
          const b = badge(s);
          return (
            <a key={i} href={it.url} target="_blank" rel="noreferrer"
              className="row" style={{ gap: 10, textDecoration: "none", borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
              <span className={b.cls} style={{ minWidth: 64, textAlign: "center" }}>{b.text}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{it.title}</div>
                <div className="muted" style={{ fontSize: 12 }}>{it.source || "source"} • {it.date}</div>
              </div>
            </a>
          );
        })}
        {!items.length && !err && <div className="muted">No headlines.</div>}
      </div>
      <style>{`
        .pill{ display:inline-block; padding:3px 8px; border-radius:999px; border:1px solid var(--border); color:var(--muted) }
        .pill.good{ color:var(--good); box-shadow: inset 0 0 0 2px rgba(52,199,89,.12) }
        .pill.bad{ color:var(--bad); box-shadow: inset 0 0 0 2px rgba(255,59,48,.12) }
      `}</style>
    </div>
  );
}
