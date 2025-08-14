// frontend/src/components/MarketCard.jsx

import React from "react";

export default function MarketCard({ market }) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: "1rem",
        marginBottom: "1rem",
        maxWidth: 500,
      }}
    >
      <h2>📊 Market Breadth & Macro</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {Object.entries(market).map(([sym, data]) => {
          const price = Number(data?.current_price);
          const pct = Number(data?.change_pct);
          const hasPct = Number.isFinite(pct);
          const up = hasPct ? pct >= 0 : null;

          return (
            <li key={sym} style={{ marginBottom: "0.5rem" }}>
              <strong>{sym}</strong>:{" "}
              {Number.isFinite(price) ? `$${price.toFixed(2)}` : "—"}{" "}
              {hasPct && (
                <span
                  style={{
                    color: up ? "#2e7d32" : "#c62828",
                    fontWeight: 600,
                    marginLeft: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                  aria-label={`${up ? "Up" : "Down"} ${Math.abs(pct).toFixed(2)} percent`}
                  title={`${up ? "Up" : "Down"} ${Math.abs(pct).toFixed(2)}%`}
                >
                  {up ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
