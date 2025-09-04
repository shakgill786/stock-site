import { useEffect, useMemo, useState } from "react";
import useLocalStorage from "../hooks/useLocalStorage";

export default function WatchlistPanel({ current, onLoad }) {
  const [watchlist, setWatchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [symbol, setSymbol] = useState("");
  const [tag, setTag] = useState("no tag");
  const [filter, setFilter] = useState("all");

  // Collapsible on mobile
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse on small screens; open on desktop
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1060px)");
    const setFromMQ = () => setCollapsed(mql.matches); // collapsed on mobile by default
    setFromMQ();
    mql.addEventListener?.("change", setFromMQ);
    return () => mql.removeEventListener?.("change", setFromMQ);
  }, []);

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
  const clearAll = () => setWatchlist([]);

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className={`card watchlist ${collapsed ? "wl-collapsed" : "wl-open"}`}>
      {/* Mobile toggle */}
      <button
        type="button"
        className="wl-toggle"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-controls="wl-content"
        title="Toggle watchlist"
      >
        <span className="ttl">
          <span>⭐</span>
          <span>Watchlist</span>
          <span className="muted" style={{ fontSize: 12 }}>({watchlist.length})</span>
        </span>
        <span className="chev">{collapsed ? "▸" : "▾"}</span>
      </button>

      {/* Desktop header */}
      <h3 className="hide-on-mobile" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <span>⭐</span> Watchlist
        <span className="muted" style={{ fontSize: 12 }}>({watchlist.length})</span>
      </h3>

      <div id="wl-content" className="wl-content">
        {/* Header row — no overlap */}
        <div className="watchlist-header">
          <input
            type="text"
            placeholder="Add ticker (e.g. MSFT)"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={onKeyDown}
            inputMode="latin"
            aria-label="Add ticker symbol"
          />
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
            <option>no tag</option>
            <option>tech</option>
            <option>fintech</option>
            <option>crypto</option>
          </select>
          <button className="btn" onClick={add}>Add</button>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <label>Filter:</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter watchlist">
            <option value="all">all</option>
            <option value="no tag">no tag</option>
            <option value="tech">tech</option>
            <option value="fintech">fintech</option>
            <option value="crypto">crypto</option>
          </select>
          {watchlist.length > 0 && (
            <button
              type="button"
              className="btn ghost show-on-mobile"
              onClick={clearAll}
              title="Clear all"
              aria-label="Clear all items"
              style={{ marginLeft: "auto" }}
            >
              Clear
            </button>
          )}
        </div>

        <div
          className="wl-scroll"
          style={{
            marginTop: 10,
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 8,
            maxHeight: 380,
            overflow: "auto"
          }}
        >
          {filtered.map(({ symbol: s, tag: t }) => (
            <div
              key={s}
              className="row"
              style={{
                justifyContent: "space-between",
                padding: "8px 8px",
                borderBottom: "1px solid #1b2446"
              }}
            >
              <div className="row" style={{ gap: 10 }}>
                <button
                  title={`Load ${s}`}
                  className="btn ghost"
                  onClick={() => onLoad?.(s)}
                  style={{
                    width: 38, height: 32, padding: 0, display: "grid", placeItems: "center"
                  }}
                  aria-label={`Load ${s}`}
                >
                  {current === s ? "●" : "○"}
                </button>
                <div style={{ minWidth: 64, fontWeight: 700 }}>{s}</div>
                <div className="muted" style={{ fontSize: 12 }}>{t || "no tag"}</div>
              </div>
              <button
                className="btn"
                onClick={() => remove(s)}
                style={{ width: 38, height: 32, padding: 0 }}
                aria-label={`Remove ${s}`}
                title={`Remove ${s}`}
              >
                ×
              </button>
            </div>
          ))}
          {filtered.length === 0 && <div className="muted">No symbols.</div>}
        </div>

        {/* Desktop-only clear */}
        {watchlist.length > 0 && (
          <div className="hide-on-mobile" style={{ marginTop: 8, textAlign: "right" }}>
            <button type="button" className="btn ghost" onClick={clearAll} title="Clear all">
              Clear all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
