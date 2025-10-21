// frontend/src/components/SentimentPanel.jsx
import { useEffect, useRef, useState } from "react";
import SentimentOverlayChart from "./SentimentOverlayChart";
import SentimentScatter from "./SentimentScatter";
import { buildSentimentAlertsStreamURL } from "../api";

export default function SentimentPanel({ ticker, watchlist = [] }) {
  const [alert, setAlert] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    // connect SSE for the entire watchlist (or just this ticker if empty)
    const tickers = watchlist?.length ? watchlist : [ticker];
    const url = buildSentimentAlertsStreamURL({ tickers, neg: -0.6, pos: 0.7, interval: 60 });
    const es = new EventSource(url, { withCredentials: false });
    esRef.current = es;
    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        setAlert(payload);
        // simple toast
        // (replace with your notification system)
        console.log("[sentiment alert]", payload);
      } catch {}
    };
    es.onerror = () => { /* network hiccup; EventSource will retry */ };
    return () => { try { es.close(); } catch {} };
  }, [ticker, watchlist]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <SentimentOverlayChart ticker={ticker} />
      <SentimentScatter ticker={ticker} />
      {alert && (
        <div className="card" style={{ borderColor: alert.alert?.type === "negative" ? "rgba(255,59,48,.35)" : "rgba(52,199,89,.35)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h4 style={{ margin: 0 }}>🔔 Sentiment Alert</h4>
            <button className="btn ghost" onClick={() => setAlert(null)}>Dismiss</button>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            {alert.ticker} {alert.alert?.type === "negative" ? "↓" : "↑"} mean {alert.mean_compound.toFixed(2)} on {alert.date} ({alert.count} items)
          </div>
        </div>
      )}
    </div>
  );
}
