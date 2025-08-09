// frontend/src/components/MarketCard.jsx

import React from "react";

export default function MarketCard({ market }) {
  return (
    <div style={{
      border: "1px solid #ddd",
      borderRadius: 8,
      padding: "1rem",
      marginBottom: "1rem",
      maxWidth: 500
    }}>
      <h2>📊 Market Breadth & Macro</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {Object.entries(market).map(([sym, data]) => (
          <li key={sym} style={{ marginBottom: "0.5rem" }}>
            <strong>{sym}</strong>: ${data.current_price} (
            {data.change_pct >= 0 ? "🔺" : "🔻"}{Math.abs(data.change_pct)}%)
          </li>
        ))}
      </ul>
    </div>
  );
}
