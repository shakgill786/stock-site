import { useMemo, useState } from "react";
import useLocalStorage from "../hooks/useLocalStorage";

const TAGS = ["", "tech", "fintech", "crypto"];

export default function WatchlistPanel({ current, onLoad }) {
  const [watchlist, setWatchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [sym, setSym] = useState("");
  const [tag, setTag] = useState("");
  const [filter, setFilter] = useState("");

  const list = useMemo(
    () => (filter ? watchlist.filter((w) => (w.tag || "") === filter) : watchlist),
    [watchlist, filter]
  );

  const add = (e) => {
    e.preventDefault();
    const s = sym.trim().toUpperCase();
    if (!s) return;
    if (!watchlist.some((w) => w.symbol === s)) {
      setWatchlist([{ symbol: s, tag: tag || "" }, ...watchlist]);
    }
    setSym("");
  };

  const remove = (symbol) => {
    setWatchlist(watchlist.filter((w) => w.symbol !== symbol));
  };

  return (
    <div style={panel}>
      <h3 style={{ margin: 0 }}>⭐ Watchlist</h3>

      <form onSubmit={add} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          value={sym}
          onChange={(e) => setSym(e.target.value.toUpperCase())}
          placeholder="Add ticker (e.g. MSFT)"
        />
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          {TAGS.map((t) => (
            <option key={t} value={t}>{t || "no tag"}</option>
          ))}
        </select>
        <button type="submit">Add</button>
      </form>

      <div style={{ marginTop: 8 }}>
        <label>
          Filter:{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {TAGS.map((t) => (
              <option key={t} value={t}>{t || "all"}</option>
            ))}
          </select>
        </label>
      </div>

      <ul style={{ listStyle: "none", padding: 0, marginTop: 10 }}>
        {list.map(({ symbol, tag }) => {
          const active = symbol === current;
          return (
            <li key={symbol} style={row}>
              <button onClick={() => onLoad(symbol)} style={loadBtn} title="Load">
                {active ? "●" : "○"}
              </button>
              <span style={{ minWidth: 70, display: "inline-block" }}>{symbol}</span>
              <span style={{ color: "#666", fontSize: 12 }}>{tag}</span>
              <button onClick={() => remove(symbol)} style={removeBtn} title="Remove">
                ✕
              </button>
            </li>
          );
        })}
        {!list.length && <li style={{ color: "#666" }}>No tickers yet.</li>}
      </ul>
    </div>
  );
}

const panel = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 12,
  minWidth: 260,
  height: "100%",
};

const row = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 0",
  borderBottom: "1px solid #f1f1f1",
};

const loadBtn = { cursor: "pointer" };
const removeBtn = { marginLeft: "auto", cursor: "pointer" };
