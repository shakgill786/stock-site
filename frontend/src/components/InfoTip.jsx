import React, { useState } from "react";

export default function InfoTip({ text = "" }) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className="info-tip-wrap"
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        type="button"
        className="info-tip-btn"
        aria-label="More info"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        style={{
          cursor: "pointer",
          background: "rgba(20,20,30,0.9)",
          border: "1px solid #a8b2ff",
          color: "#a8b2ff",
          width: 16,
          height: 16,
          minWidth: 16,
          minHeight: 16,
          borderRadius: "999px",
          lineHeight: "14px",
          fontSize: 10,
          fontWeight: 600,
          padding: 0,
          textAlign: "center",
        }}
      >
        i
      </button>

      {open && (
        <div
          className="info-tip-bubble"
          role="tooltip"
          style={{
            position: "absolute",
            left: "20px",
            top: 0,
            zIndex: 9999,
            minWidth: 220,
            maxWidth: 260,
            background: "rgba(0,0,0,0.9)",
            border: "1px solid rgba(168,178,255,0.5)",
            color: "#fff",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 11,
            lineHeight: 1.4,
            boxShadow: "0 10px 24px rgba(0,0,0,0.7)",
          }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {text}
        </div>
      )}
    </span>
  );
}
