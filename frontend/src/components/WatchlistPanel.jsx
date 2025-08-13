import { useMemo, useState } from "react";
import useLocalStorage from "../hooks/useLocalStorage";

export default function WatchlistPanel({ current, onLoad }) {
  const [watchlist, setWatchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [symbol, setSymbol] = useState("");
  const [tag, setTag] = useState("no tag");
  const [filter, setFilter] = useState("all");

  const filtered = useMemo(() => {
    if (filter === "all") return watchlist;
    return watchlist.filter((w) => (w.tag || "no tag") === filter);
  }, [watchlist, filter]);

  const add = () => {
    const s = symbol.trim().toUpperCase();
    if (!s) return;
    if (!watchlist.some((w) => w.symbol === s)) {
      setWatchlist([...watchlist, { symbol: s, tag }]);
    }
    setSymbol("");
  };

  const remove = (s) => setWatchlist(watchlist.filter((w) => w.symbol !== s));

  return (
    <div className="card">
      <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <span>⭐</span> Watchlist
      </h3>

      {/* Header row — no overlap */}
      <div className="watchlist-header">
        <input
          type="text"
          placeholder="Add ticker (e.g. MSFT)"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option>no tag</option>
          <option>tech</option>
          <option>fintech</option>
          <option>crypto</option>
        </select>
        <button className="btn" onClick={add}>Add</button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <label>Filter:</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">all</option>
          <option value="no tag">no tag</option>
          <option value="tech">tech</option>
          <option value="fintech">fintech</option>
          <option value="crypto">crypto</option>
        </select>
      </div>

      <div style={{
        marginTop: 10,
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 8,
        maxHeight: 380,
        overflow: "auto"
      }}>
        {filtered.map(({ symbol: s, tag: t }) => (
          <div key={s} className="row"
               style={{ justifyContent: "space-between", padding: "6px 8px", borderBottom: "1px solid #1b2446" }}>
            <div className="row" style={{ gap: 10 }}>
              <button
                title="Load"
                className="btn ghost"
                onClick={() => onLoad?.(s)}
                style={{ width: 32, height: 28, padding: 0, display: "grid", placeItems: "center" }}
              >
                {current === s ? "●" : "○"}
              </button>
              <div style={{ minWidth: 64 }}>{s}</div>
              <div className="muted" style={{ fontSize: 12 }}>{t || "no tag"}</div>
            </div>
            <button className="btn" onClick={() => remove(s)} style={{ width: 32, height: 28, padding: 0 }}>
              ×
            </button>
          </div>
        ))}
        {filtered.length === 0 && <div className="muted">No symbols.</div>}
      </div>
    </div>
  );
}
