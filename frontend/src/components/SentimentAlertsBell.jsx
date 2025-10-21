// frontend/src/components/SentimentAlertsBell.jsx
import { useEffect, useRef, useState } from "react";
import useEventSource from "../hooks/useEventSource";

/**
 * Minimal alerts pill that listens to SSE from /sentiment/alerts_stream
 * Props:
 *  - url: string | null (constructed via buildSentimentStreamURL)
 */
export default function SentimentAlertsBell({ url }) {
  const [last, setLast] = useState(null); // last alert payload
  const [count, setCount] = useState(0);

  useEventSource(url, {
    enabled: !!url,
    onMessage: (payload) => {
      setLast(payload);
      setCount((n) => n + 1);
      // Optional: sound or toast here
      // new Audio('/ding.mp3').play().catch(()=>{});
    },
  });

  if (!url) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        alerts off
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        padding: 8,
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderLeft: "4px solid #a8b2ff",
      }}
    >
      <span>🔔 Sentiment alerts</span>
      <span className="muted" style={{ fontSize: 12 }}>
        {count ? `${count} event${count > 1 ? "s" : ""}` : "listening…"}
      </span>
      {last && (
        <div className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          {last?.ticker}: {Number(last?.score).toFixed(3)} ({last?.level})
        </div>
      )}
    </div>
  );
}
