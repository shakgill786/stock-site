// frontend/src/components/HotAndEarnings.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchQuote, fetchEarnings } from "../api";
import useLocalStorage from "../hooks/useLocalStorage";

// A safe, lightweight default set. You can pass your own `tickers` prop
// (e.g., the S&P 500 list) without touching this file.
const DEFAULT_TICKERS = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","BRK-B","JPM",
  "UNH","XOM","LLY","JNJ","V","PG","MA","COST","HD","ADBE",
  "ORCL","NFLX","CSCO","PEP","KO","ABBV","MRK","CRM","BAC","WMT",
  "AMD","LIN","ACN","MCD","TXN","TMUS","NKE","AMAT","INTU","PYPL"
];

function withinNextDays(dateStr, days = 7) {
  if (!dateStr) return false;
  const today = new Date();
  const end = new Date();
  end.setDate(today.getDate() + days);
  const d = new Date(String(dateStr).slice(0, 10));
  return d >= new Date(today.toDateString()) && d <= end;
}

async function withTimeout(promise, ms = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await promise(controller.signal);
    return res;
  } finally {
    clearTimeout(t);
  }
}

export default function HotAndEarnings({
  tickers = DEFAULT_TICKERS,
  useWatchlist = false,
  topNHot = 8,
  maxEarnings = 20,
}) {
  const [watchlist] = useLocalStorage("WATCHLIST_V1", []);
  const [source, setSource] = useState(useWatchlist ? "watchlist" : "default");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]); // { symbol, quote, earnings }
  const [error, setError] = useState("");
  const verRef = useRef(0);

  const symbols = useMemo(() => {
    if (source === "watchlist") {
      const wl = (watchlist || []).map((w) => w.symbol).filter(Boolean);
      return wl.length ? wl : DEFAULT_TICKERS;
    }
    return tickers && tickers.length ? tickers : DEFAULT_TICKERS;
  }, [source, watchlist, tickers]);

  useEffect(() => {
    let cancelled = false;
    const myVer = ++verRef.current;

    const run = async () => {
      setError("");
      setLoading(true);
      try {
        // limit concurrency a bit so we don’t hammer the backend
        const chunkSize = 10;
        const out = [];

        for (let i = 0; i < symbols.length; i += chunkSize) {
          const chunk = symbols.slice(i, i + chunkSize);
          /* eslint-disable no-await-in-loop */
          const part = await Promise.all(
            chunk.map(async (s) => {
              const symbol = String(s).toUpperCase().trim();
              try {
                const [q, e] = await Promise.all([
                  withTimeout(async (signal) => fetchQuote(symbol), 7000),
                  withTimeout(async (signal) => fetchEarnings(symbol), 7000),
                ]);
                return { symbol, quote: q, earnings: e };
              } catch {
                return { symbol, quote: null, earnings: null };
              }
            })
          );
          if (cancelled || verRef.current !== myVer) return;
          out.push(...part);
        }

        if (!cancelled && verRef.current === myVer) setRows(out);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [symbols]);

  // -------- Views --------
  const hot = useMemo(() => {
    const items = rows
      .map((r) => {
        const pct = Number(r?.quote?.change_pct);
        const last = Number(r?.quote?.last_close);
        const now = Number(r?.quote?.current_price);
        return {
          symbol: r.symbol,
          changePct: Number.isFinite(pct) ? pct : null,
          lastClose: Number.isFinite(last) ? last : null,
          current: Number.isFinite(now) ? now : null,
        };
      })
      .filter((x) => x.changePct != null)
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, topNHot);
    return items;
  }, [rows, topNHot]);

  const earningsSoon = useMemo(() => {
    const items = rows
      .map((r) => {
        const next = r?.earnings?.next_report_date || r?.earnings?.next || r?.earnings?.date;
        return {
          symbol: r.symbol,
          date: next ? String(next).slice(0, 10) : null,
        };
      })
      .filter((x) => withinNextDays(x.date, 7))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, maxEarnings);
    return items;
  }, [rows, maxEarnings]);

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>🔥 Hot & 🗓️ Earnings (Simple)</h2>
        <div className="row" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 6 }}>
            Source:
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="default">Built-in list</option>
              <option value="watchlist">Your Watchlist</option>
            </select>
          </label>
        </div>
      </div>

      {error && <div style={{ color: "salmon", marginTop: 8 }}>Error: {error}</div>}
      {loading && <div className="muted" style={{ marginTop: 8 }}>Loading…</div>}

      <div className="row" style={{ gap: 16, marginTop: 12, flexWrap: "wrap" }}>
        {/* Hot movers */}
        <section className="card" style={{ minWidth: 320, flex: "1 1 360px" }}>
          <h3 style={{ marginTop: 0 }}>🔥 Hot Stocks Today</h3>
          {hot.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th style={{ textAlign: "right" }}>Last</th>
                    <th style={{ textAlign: "right" }}>Now</th>
                    <th style={{ textAlign: "right" }}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {hot.map((x) => (
                    <tr key={x.symbol}>
                      <td>{x.symbol}</td>
                      <td style={{ textAlign: "right" }}>
                        {x.lastClose != null ? `$${x.lastClose.toFixed(2)}` : "—"}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {x.current != null ? `$${x.current.toFixed(2)}` : "—"}
                      </td>
                      <td
                        style={{
                          textAlign: "right",
                          color: x.changePct >= 0 ? "#2e7d32" : "#c62828",
                          fontWeight: 600,
                        }}
                      >
                        {x.changePct != null ? `${x.changePct.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">No movers found.</div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Sorted by absolute % change among the selected symbols.
          </div>
        </section>

        {/* Earnings this week */}
        <section className="card" style={{ minWidth: 320, flex: "1 1 360px" }}>
          <h3 style={{ marginTop: 0 }}>🗓️ Earnings (Next 7 Days)</h3>
          {earningsSoon.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {earningsSoon.map((x) => (
                    <tr key={`${x.symbol}-${x.date}`}>
                      <td>{x.symbol}</td>
                      <td>{x.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">No earnings in the next 7 days.</div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Uses your API’s per-ticker earnings endpoint; pass a larger ticker list if you want full S&amp;P 500.
          </div>
        </section>
      </div>
    </div>
  );
}
