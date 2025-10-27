import React from "react";
import InfoTip from "./InfoTip";

export default function SectionHeader({ title, infoText, style }) {
  return (
    <div
      className="row"
      style={{
        alignItems: "baseline",
        justifyContent: "space-between",
        marginBottom: 6,
        ...style,
      }}
    >
      <h3
        style={{
          margin: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "1rem",
          fontWeight: 600,
        }}
      >
        <span>{title}</span>
        {infoText && <InfoTip text={infoText} />}
      </h3>
    </div>
  );
}
