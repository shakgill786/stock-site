import { useEffect, useMemo, useRef, useState } from "react";
import { fetchMovers, fetchPredict, fetchQuote } from "../api";

const DEFAULT_MODELS = ["LSTM", "ARIMA"]; // falls back if you don't pass modelsHint

// ---- utils (same spirit as App.jsx) ----
const toNum = (v) => (typeof v === "number" ? v : Number(v));
const isNum = (v) => Number.isFinite(toNum(v));

const normModel = (s) => String(s || "").trim().toUpperCase();

function computeMetrics({ quote, result }) {
  // base = last_close (same as App.jsx logic)
  const base = Number(quote?.last_close) || 0;
  if (!base || !result?.predictions?.length) return null;

  const preds = result.predictions.map(Number).filter(Number.isFinite);
  if (!preds.length) return null;

  const meanPred = preds.reduce((a, b) => a + b, 0) / preds.length;
  const avgChangePct = ((meanPred - base) / base) * 100;

  const mapeProxy =
    preds.reduce((acc, p) => acc + Math.abs(p - base) / base, 0) / preds.length;

  return { model: result.model, mapeProxy, avgChangePct };
}

function decideAction(avgChangePct) {
  if (!Number.isFinite(avgChangePct)) return "Hold";
  if (avgChangePct > 1) return "Buy";
  if (avgChangePct < -1) return "Sell";
  return "Hold";
}

// tiny concurrency limiter
async function mapLimit(items, limit, worker) {
  const ret = [];
  let i = 0;
  let running = 0;
  let resolveAll;
  const done = new Promise((res) => (resolveAll = res));

  const launch = () => {
    while (running < limit && i < items.length) {
      const idx = i++;
      running++;
      Promise.resolve(worker(items[idx], idx))
        .then((val) => (ret[idx] = val))
        .catch(() => (ret[idx] = null))
        .finally(() => {
          running--;
          if (ret.length === items.length && running === 0) resolveAll();
          else launch();
        });
    }
  };
  launch();
  await done;
  return ret;
}

export default function TopBuysCard({
  onPick,
  modelsHint = DEFAULT_MODELS,
  // optional: supply your own candidates (e.g., from watchlist); otherwise we use movers
  candidateSymbols,
  title = "Top 25 Buys (program rating)",
  maxCandidates = 60, // scan up to this many symbols
  concurrency = 5,     // parallel calls to keep it snappy but not abusive
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);
  const isAlive = useRef(true);

  useEffect(() => {
    isAlive.current = true;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        // 1) candidate symbols
        let syms = Array.isArray(candidateSymbols) && candidateSymbols.length
          ? candidateSymbols
          : undefined;

        if (!syms) {
          const mv = await fetchMovers();
          const g = (mv?.gainers || []).map((r) => String(r.symbol || r.ticker || "").toUpperCase());
          const l = (mv?.losers  || []).map((r) => String(r.symbol || r.ticker || "").toUpperCase());
          syms = [...new Set([...g, ...l])];
        }
        syms = syms
          .map((s) => String(s || "").toUpperCase())
          .filter(Boolean)
          .slice(0, maxCandidates);

        // 2) evaluate each symbol (quote + predict)
        const models = (modelsHint || DEFAULT_MODELS).map(normModel);

        const evaluated = await mapLimit(syms, concurrency, async (sym) => {
          try {
            const [q, res] = await Promise.all([
              fetchQuote(sym),
              fetchPredict({ ticker: sym, models }),
            ]);

            const results = Array.isArray(res?.results) ? res.results : [];
            if (!results.length) return null;

            // compute per-model metrics
            const metricsByModel = results
              .map((r) => computeMetrics({ quote: q, result: r }))
              .filter(Boolean);

            if (!metricsByModel.length) return null;

            // pick best by lowest mapeProxy
            metricsByModel.sort((a, b) => a.mapeProxy - b.mapeProxy);
            const best = metricsByModel[0];
            const action = decideAction(best.avgChangePct);

            return {
              symbol: sym,
              price: Number(q?.last_close) || Number(q?.current_price) || null,
              ...best,
              action,
            };
          } catch {
            return null;
          }
        });

        // 3) keep only Buys, sort by upside desc, top 25
        const buys = (evaluated || [])
          .filter(Boolean)
          .filter((x) => x.action === "Buy" && Number.isFinite(x.avgChangePct))
          .sort((a, b) => b.avgChangePct - a.avgChangePct)
          .slice(0, 25);

        if (isAlive.current) setRows(buys);
      } catch (e) {
        if (isAlive.current) setErr(e?.message || "Failed to build Top Buys.");
      } finally {
        if (isAlive.current) setLoading(false);
      }
    })();

    return () => {
      isAlive.current = false;
    };
  }, [candidateSymbols, modelsHint, maxCandidates, concurrency]);

  return (
    <div className="he-card">
      <div className="he-card-head">
        <h3>{title}</h3>
        <div className="he-head-right">
          {loading ? <span className="muted">Scanning…</span> : null}
        </div>
      </div>

      {err ? (
        <div className="muted error">{err}</div>
      ) : !rows.length ? (
        <div className="muted">{loading ? "Loading…" : "No current Buy signals."}</div>
      ) : (
        <div className="he-scroll">
          <table className="he-table">
            <colgroup>
              <col style={{ width: "10%" }} />
              <col style={{ width: "25%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "25%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Symbol</th>
                <th className="num">% Upside (avg)</th>
                <th className="num">Best Model</th>
                <th className="num">mapeProxy ↓</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.symbol}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <button
                      type="button"
                      className="ticker-link"
                      onClick={() => {
                        onPick?.(r.symbol);
                        window.dispatchEvent(new CustomEvent("ticker:set", { detail: r.symbol }));
                      }}
                      title={`Load ${r.symbol}`}
                    >
                      {r.symbol}
                    </button>
                  </td>
                  <td className="num" style={{ color: r.avgChangePct >= 0 ? "#2e7d32" : "#c62828", fontWeight: 600 }}>
                    {r.avgChangePct.toFixed(2)}%
                  </td>
                  <td className="num">{r.model}</td>
                  <td className="num">{r.mapeProxy.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <style>{`
        .he-card {
          padding: 12px; overflow: hidden; border-radius: 14px;
          background: radial-gradient(120% 120% at 100% 0%, rgba(160,170,255,0.06), rgba(25,28,45,0.6) 55%, rgba(17,20,35,0.8));
          border: 1px solid rgba(255,255,255,0.07); box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        }
        .he-card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
        .he-head-right { display: flex; gap: 10px; align-items: center; }
        .he-scroll { max-height: 420px; overflow: auto; border-radius: 12px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); }
        .he-table { width: 100%; table-layout: fixed; font-size: 13px; border-collapse: separate; border-spacing: 0; }
        .he-table thead th { position: sticky; top: 0; background: rgba(12,14,24,0.85); backdrop-filter: blur(2px); z-index: 2; padding: 8px 10px; }
        .he-table tbody tr:nth-child(odd) { background: rgba(255,255,255,0.02); }
        .he-table td, .he-table th { vertical-align: middle; padding: 8px 10px; }
        .num { text-align: right; font-variant-numeric: tabular-nums; }
        .ticker-link{ background: transparent; border: none; padding: 0; margin: 0; cursor: pointer; color: #a2c4ff; text-decoration: underline; text-underline-offset: 2px; font: inherit; font-weight: 700; letter-spacing: .2px; }
        .ticker-link:hover{ color: #d6e3ff; text-shadow: 0 0 6px rgba(110,168,255,.45); text-decoration-thickness: 2px; }
        .muted { color: #a7adbc; } .muted.error { color: #ff6b6b; }
      `}</style>
    </div>
  );
}
