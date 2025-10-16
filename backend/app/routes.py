# app/routes.py
from fastapi import APIRouter, Query
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple, Optional
import random, json, asyncio, time, os, math
from datetime import date, timedelta
from starlette.responses import StreamingResponse
import httpx

from app.services.finance_service import (
    get_quote,
    get_earnings,
    get_market_breadth,
    get_daily_closes_with_dates,
    get_daily_closes,  # used by movers fallback + predict() fallback
    get_52w_stats,
)

router = APIRouter()

# ----------------------- normalization / clamping -----------------------
CLAMP_PCT_BOUNDS: Tuple[float, float] = (-25.0, 25.0)  # UI sanity window
HARD_LAST_MULTIPLIER = 1.95  # reject last beyond ±95% of prevClose (vendor glitch)

def _to_float(x):
    try:
        s = str(x).strip().replace("%", "").replace(",", "")
        return float(s)
    except Exception:
        return None

def _safe_pct(last: Optional[float], prev: Optional[float]) -> float:
    try:
        if last is None or prev is None: return 0.0
        if not isinstance(last, (int, float)) or not isinstance(prev, (int, float)): return 0.0
        if prev == 0 or math.isnan(last) or math.isnan(prev): return 0.0
        return ((float(last) - float(prev)) / float(prev)) * 100.0
    except Exception:
        return 0.0

def _normalize_tile_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize a movers/top_gainers/top_losers row to avoid goofy values like +140.75%:
      - compute percent from price & last if vendor percent is missing/bad
      - fix 'percent' that is actually dollars
      - clamp % to ±25 for DISPLAY (keep originals as *_raw)
    Input expected keys (best-effort): symbol, price, change, change_pct
    """
    sym = str(row.get("symbol") or row.get("ticker") or "").upper()
    price = _to_float(row.get("price"))
    chg   = _to_float(row.get("change"))
    pct   = _to_float(row.get("change_pct"))

    # try to infer prev from price & change when missing
    prev = None
    if price is not None and chg is not None:
        prev = price - chg

    normalized_reason: List[str] = []
    was_clamped = False

    # if pct missing or non-numeric, compute from price/prev
    if pct is None:
        pct = _safe_pct(price, prev)
        normalized_reason.append("computed_percent_from_prices")

    # heuristic: if |pct| huge but treating pct as dollars makes sense, fix it
    if abs(pct) > 60 and prev and prev != 0:
        as_dollars_pct = (pct / prev) * 100.0
        if abs(as_dollars_pct) <= 60:
            # pct was actually dollar change; recompute correctly
            chg = pct
            pct = _safe_pct(price, prev)
            normalized_reason.append("vendor_percent_was_dollars")

    # if price is wildly off vs prev (vendor glitch), rebuild price from prev + change
    if prev and price and (price <= (1 - HARD_LAST_MULTIPLIER) * prev or price >= HARD_LAST_MULTIPLIER * prev):
        if chg is not None:
            recomputed_last = prev + chg
            if abs(_safe_pct(recomputed_last, prev)) < abs(_safe_pct(price, prev)):
                price = recomputed_last
                pct = _safe_pct(price, prev)
                normalized_reason.append("recomputed_last_from_change")

    # final consistency nudge if pct & chg disagree badly
    if prev and pct is not None and chg is None:
        chg = (pct / 100.0) * prev

    # DISPLAY clamp only
    lb, ub = CLAMP_PCT_BOUNDS
    pct_raw = pct
    if pct < lb:
        pct = lb
        was_clamped = True
    elif pct > ub:
        pct = ub
        was_clamped = True
    chg_display = ((pct / 100.0) * (prev if prev else price)) if (prev or price) else chg

    return {
        "symbol": sym,
        "price": price,
        "change": chg,
        "change_pct": pct_raw,                 # original/unclamped vendor percent (may be wrong)
        "display_change_pct": round(pct, 4),   # <-- use this on the frontend tiles
        "display_change": round((chg_display or 0.0), 4),
        "normalized": bool(normalized_reason or was_clamped),
        "normalized_reason": "|".join(normalized_reason) if normalized_reason else None,
        "was_clamped": was_clamped,
        "clamp_bounds": {"min": lb, "max": ub} if was_clamped else None,
    }

def _normalize_quote_payload(q: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalizes /quote output and adds display fields.
    Expected keys from service: current_price, last_close, change_pct (maybe)
    """
    out = dict(q or {})
    price = _to_float(out.get("current_price"))
    last  = _to_float(out.get("last_close"))
    pct   = _to_float(out.get("change_pct"))

    reasons: List[str] = []
    was_clamped = False

    if pct is None:
        pct = _safe_pct(price, last)
        reasons.append("computed_percent_from_prices")

    # vendor-dollars-as-percent fix
    if abs(pct) > 60 and last and last != 0:
        as_dollars_pct = (pct / last) * 100.0
        if abs(as_dollars_pct) <= 60:
            # pct was dollars
            pct = _safe_pct(price, last)
            reasons.append("vendor_percent_was_dollars")

    # hard sanity for 'price' vs last
    if last and price and (price <= (1 - HARD_LAST_MULTIPLIER) * last or price >= HARD_LAST_MULTIPLIER * last):
        # rebuild price if change available
        chg = _to_float(out.get("change"))
        if chg is not None:
            recomputed = last + chg
            if abs(_safe_pct(recomputed, last)) < abs(_safe_pct(price, last)):
                price = recomputed
                reasons.append("recomputed_last_from_change")

    # display clamp
    lb, ub = CLAMP_PCT_BOUNDS
    pct_raw = pct
    if pct < lb:
        pct = lb; was_clamped = True
    elif pct > ub:
        pct = ub; was_clamped = True

    out["display_change_pct"] = round(pct, 4)
    out["display_change"] = round(((pct / 100.0) * (last if last else price or 0.0)), 4)
    out["normalized"] = bool(reasons or was_clamped)
    out["normalized_reason"] = "|".join(reasons) if reasons else None
    out["was_clamped"] = was_clamped
    out["clamp_bounds"] = {"min": lb, "max": ub} if was_clamped else None
    return out

# ----------------------- helpers (existing) -----------------------
def _is_crypto(symbol: str) -> bool:
    return "-" in (symbol or "").upper()  # BTC-USD etc.

def _filter_equity_calendar(dates: List[str], closes: List[float]) -> Tuple[List[str], List[float]]:
    """
    Drop weekends and usually 'today' so we keep completed trading days.
    Defensive: if the provider only returns 'today', keep it so the UI isn't empty.
    Assumes dates are ISO strings (YYYY-MM-DD), most-recent last.
    """
    if not dates or not closes or len(dates) != len(closes):
        return dates or [], closes or []

    today_iso = date.today().isoformat()
    out_d, out_c = [], []

    for d, c in zip(dates, closes):
        ds = str(d)[:10]
        try:
            dt = date.fromisoformat(ds)
        except Exception:
            out_d.append(ds); out_c.append(float(c)); continue

        dow = dt.weekday()  # 0=Mon..6=Sun
        if dow >= 5:  # weekend
            continue

        # Only drop 'today' if we already retained at least one earlier day
        if ds == today_iso and out_d:
            continue

        out_d.append(ds)
        out_c.append(float(c))

    # If nothing left (e.g., only 'today' existed), keep last point
    if not out_d and dates and closes:
        ds = str(dates[-1])[:10]
        return [ds], [float(closes[-1])]

    return out_d, out_c

async def _pin_last_close_async(symbol: str, dates: List[str], closes: List[float]) -> None:
    """For equities, replace the last close with quote.last_close for consistency (non-blocking)."""
    if not dates or not closes or _is_crypto(symbol):
        return
    try:
        q = await asyncio.to_thread(get_quote, symbol)
        last_close = q.get("last_close")
        if last_close is not None:
            closes[-1] = float(last_close)
    except Exception:
        pass

def _norm_symbol(s: str) -> str:
    return (s or "").strip().upper()

def _alpha_to_common(item: dict) -> dict:
    """Alpha Vantage TOP_GAINERS_LOSERS -> {symbol, price, change, change_pct, name}"""
    sym = _norm_symbol(item.get("ticker") or item.get("symbol"))
    price = _to_float(item.get("price"))
    change = _to_float(item.get("change_amount"))
    change_pct = _to_float(item.get("change_percentage"))
    name = item.get("ticker") or sym  # AV doesn’t include company name here
    return {"symbol": sym, "price": price, "change": change, "change_pct": change_pct, "name": name}

# Universe for fallback movers (env POPULAR_TICKERS or this default)
_FALLBACK_UNIVERSE = [
    "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","NFLX","AMD",
    "JPM","V","MA","XOM","CVX","WMT","HD","PG","KO","PEP",
    "UNH","JNJ","LLY","PFE","BAC","C","GS","MS","CSCO","ORCL",
    "ADBE","CRM","QCOM","TXN","INTC","T","VZ","DIS","NKE","COST",
    "MCD","ABT","TMO","UPS","LOW","IBM","CAT","HON","BA","PYPL",
    "AMAT","MU","NOW","SHOP","PLTR","UBER","ABNB","MRNA","SQ","ROKU",
    "SNOW","ZS","CRWD","PANW","SMCI","DE","GM","F","FDX","LMT",
    "GE","MMM","MDLZ","MO","PM","BKNG","AXP","ADP","SPGI","ICE"
]

def _universe_from_env() -> List[str]:
    raw = os.getenv("POPULAR_TICKERS", "")
    if raw.strip():
        toks = [t.strip().upper() for t in raw.split(",") if t.strip()]
        if toks:
            return toks[:200]
    return _FALLBACK_UNIVERSE

# ----------------------- diagnostics -----------------------
@router.get("/diag", summary="Diag", tags=["Diagnostics"])
async def diag(ticker: str = "AAPL"):
    """
    Check quote latency, provider history, and yfinance fallback availability.
    """
    import time as _time
    t0 = _time.time()
    q_err = None
    try:
        q = await asyncio.to_thread(get_quote, ticker)
    except Exception as e:
        q, q_err = {}, str(e)
    t1 = _time.time()

    prov_dates = prov_closes = []
    prov_err = None
    try:
        s = await asyncio.to_thread(get_daily_closes_with_dates, ticker, 7)
        prov_dates = list(s.get("dates") or [])
        prov_closes = list(s.get("closes") or [])
    except Exception as e:
        prov_err = str(e)

    yfin_ok = False
    yfin_pts = 0
    yfin_err = None
    try:
        import yfinance as yf  # noqa
        yfin_ok = True
        df = await asyncio.to_thread(
            yf.download, ticker, period="3mo", interval="1d", progress=False, auto_adjust=True
        )
        if df is not None and not df.empty and "Close" in df:
            yfin_pts = int(df["Close"].dropna().shape[0])
    except Exception as e:
        yfin_err = str(e)

    return {
        "ticker": ticker,
        "quote_latency_ms": int((t1 - t0) * 1000),
        "quote_sample": {k: q.get(k) for k in ("ticker", "current_price", "last_close", "change_pct")},
        "provider": {"closes_len": len(prov_closes), "err": prov_err},
        "yfinance": {"installed": yfin_ok, "points": yfin_pts, "err": yfin_err},
        "quote_err": q_err,
    }

# ----------------------- predictions (unchanged) -----------------------
class PredictRequest(BaseModel):
    ticker: str
    models: List[str]

class ModelPrediction(BaseModel):
    model: str
    predictions: List[float]
    confidence: List[float]

class PredictResponse(BaseModel):
    results: List[ModelPrediction]

@router.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest):
    """
    Demo predictions based on current price.
    Robust to quote failures by falling back to last available historical close.
    """
    symbol = req.ticker.upper().strip()

    # Base price with safe fallback
    base: Optional[float] = None
    try:
        q = await asyncio.to_thread(get_quote, symbol)
        base = float(q.get("current_price"))
    except Exception:
        try:
            closes = await asyncio.to_thread(get_daily_closes, symbol, 5)
            if closes:
                base = float(closes[-1])
        except Exception:
            pass
    if base is None:
        base = 100.0  # ultra-safe fallback so UI never dies

    # deterministic predictions per model
    random.seed(symbol)
    results: List[ModelPrediction] = []
    for m in req.models:
        preds = [round(base * (1 + random.uniform(-0.05, 0.05)), 2) for _ in range(7)]
        confs = [round(random.uniform(0.7, 1.0), 2) for _ in range(7)]
        results.append(ModelPrediction(model=m, predictions=preds, confidence=confs))
    return PredictResponse(results=results)

# ---------- Retrospective “prediction for the target date” ----------
@router.get("/predict_history", summary="Predict History")
async def predict_history(
    ticker: str,
    days: int = 12,
    models: List[str] = Query(default=None),
):
    # ... (UNCHANGED — keep your existing block) ...
    symbol = str(ticker).upper()
    days = max(1, min(int(days), 60))

    def _normalize_models_param(models: Optional[List[str]]) -> List[str]:
        default = ["LSTM", "ARIMA", "RandomForest"]
        if not models:
            return default
        out: List[str] = []
        for m in models:
            if m is None:
                continue
            for part in str(m).split(","):
                name = part.strip()
                if not name:
                    continue
                up = name.upper()
                if up in {"LSTM", "ARIMA"}:
                    out.append(up)
                elif up in {"RF", "RANDOMFOREST"}:
                    out.append("RandomForest")
                elif up in {"XGB", "XGBOOST"}:
                    out.append("XGBoost")
                else:
                    out.append(name)
        seen = set(); dedup: List[str] = []
        for m in out:
            if m not in seen:
                seen.add(m); dedup.append(m)
        return dedup or default

    models = _normalize_models_param(models)

    try:
        series = await asyncio.wait_for(
            asyncio.to_thread(get_daily_closes_with_dates, symbol, days + 40),
            timeout=8.0,
        )
    except Exception:
        series = {"dates": [], "closes": []}

    dates: List[str] = list(series.get("dates") or [])
    closes: List[float] = list(series.get("closes") or [])

    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)

    if len(closes) < 2:
        try:
            import yfinance as yf
            df = await asyncio.to_thread(
                yf.download, symbol, period="3mo", interval="1d", progress=False, auto_adjust=True
            )
            if df is not None and not df.empty and "Close" in df:
                s = df["Close"].dropna().astype(float)
                dates = [str(d.date()) for d in s.index]
                closes = [float(v) for v in s.values]
                if not _is_crypto(symbol):
                    dates, closes = _filter_equity_calendar(dates, closes)
        except Exception:
            pass

    n = len(closes)
    if n < 2:
        return {"ticker": symbol, "models": models, "rows": []}

    await _pin_last_close_async(symbol, dates, closes)

    indices = list(range(1, n))
    targets = indices[-days:]

    model_bias = {"LSTM": 0.0020, "ARIMA": 0.0, "RandomForest": -0.0010, "XGBoost": 0.0015}

    rows: List[Dict[str, Any]] = []
    for i in targets:
        target_date = dates[i][:10]
        actual = float(closes[i])
        prev_close = float(closes[i - 1])

        pred_map: Dict[str, float] = {}
        err_map: Dict[str, float] = {}
        for m in models:
            rng = random.Random(f"{symbol}:{m}:{target_date}")
            noise = rng.uniform(-0.02, 0.02)  # ±2%
            bias = model_bias.get(m, 0.0)
            pred_val = round(prev_close * (1 + bias + noise), 2)
            pred_map[m] = pred_val
            err_map[m] = round(((pred_val - actual) / (actual if actual else 1.0)) * 100.0, 2)

        flat = {m: pred_map.get(m, None) for m in models}
        flat_err = {f"{m}_err_pct": err_map.get(m, None) for m in models}

        rows.append({
            "date": target_date,
            "close": round(actual, 2),
            "actual": round(actual, 2),
            "pred": pred_map,
            "error_pct": err_map,
            **flat,
            **flat_err,
        })

    return {"ticker": symbol, "models": models, "rows": rows}

# ----------------------- Quote / Earnings / Market -----------------------
@router.get("/quote", summary="Quote Endpoint")
async def quote_endpoint(ticker: str):
    q = await asyncio.to_thread(get_quote, ticker)
    return _normalize_quote_payload(q)

@router.get("/earnings", summary="Earnings Endpoint")
async def earnings_endpoint(ticker: str):
    return await asyncio.to_thread(get_earnings, ticker)

@router.get("/market", summary="Market Endpoint")
async def market_endpoint():
    """
    If your market endpoint returns index tiles (e.g., SPY/QQQ/DIA),
    run them through the same normalizer for consistency.
    """
    data = await asyncio.to_thread(get_market_breadth)
    # If data already a dict with 'items': normalize each if it looks like a tile
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        items = []
        for r in data["items"]:
            # map common keys so _normalize_tile_row can handle them
            row = {
                "symbol": r.get("symbol") or r.get("ticker"),
                "price": r.get("price") or r.get("last"),
                "change": r.get("change"),
                "change_pct": r.get("change_pct") or r.get("percent"),
            }
            items.append(_normalize_tile_row(row))
        return {"items": items, "ts": int(time.time() * 1000)}
    return data

# ----------------------- Live quote stream (SSE) -----------------------
@router.get("/quote_stream", summary="Quote Stream")
async def quote_stream(ticker: str, interval: float = 5.0):
    interval = max(1.0, min(float(interval), 60.0))

    async def event_gen():
        try:
            while True:
                q = await asyncio.to_thread(get_quote, ticker)
                q = _normalize_quote_payload(q)
                payload = {
                    "ticker": q.get("ticker", str(ticker).upper()),
                    "current_price": q.get("current_price"),
                    "last_close": q.get("last_close"),
                    "change_pct": q.get("display_change_pct"),  # use display-safe %
                    "ts": int(time.time()),
                }
                yield f"data: {json.dumps(payload)}\n\n"
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            return

    return StreamingResponse(event_gen(), media_type="text/event-stream")

# ----------------------- Closes for charts (unchanged logic) -----------------------
@router.get("/closes", summary="Closes Endpoint")
async def closes_endpoint(ticker: str, days: int = 60):
    # (keep as in your file)
    symbol = str(ticker).upper()
    days = max(2, min(int(days), 1825))

    try:
        data = await asyncio.wait_for(
            asyncio.to_thread(get_daily_closes_with_dates, symbol, days),
            timeout=8.0,
        )
    except Exception:
        data = {"dates": [], "closes": []}

    dates: List[str] = list(data.get("dates") or [])
    closes: List[float] = list(data.get("closes") or [])

    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)
        await _pin_last_close_async(symbol, dates, closes)

    if len(closes) < 1:
        try:
            import yfinance as yf
            df = await asyncio.to_thread(
                yf.download, symbol, period="3mo", interval="1d", progress=False, auto_adjust=True
            )
            if df is not None and not df.empty and "Close" in df:
                s = df["Close"].dropna().astype(float)
                dates = [str(d.date()) for d in s.index]
                closes = [float(v) for v in s.values]
                if not _is_crypto(symbol):
                    dates, closes = _filter_equity_calendar(dates, closes)
                    await _pin_last_close_async(symbol, dates, closes)
        except Exception:
            pass

    return {"ticker": symbol, "dates": dates, "closes": closes}

# ----------------------- Quick stats (unchanged) -----------------------
@router.get("/stats", summary="Stats Endpoint")
async def stats_endpoint(ticker: str):
    # (keep as in your file)
    symbol = str(ticker).upper()

    try:
        stats = await asyncio.to_thread(get_52w_stats, symbol) or {}
        hi = stats.get("high_52w"); lo = stats.get("low_52w")
        if isinstance(hi, (int, float)) and isinstance(lo, (int, float)):
            hi = float(hi); lo = float(lo)
            return {
                "ticker": symbol,
                "high_52w": hi, "low_52w": lo,
                "high": hi, "low": lo,
                "high52": hi, "low52": lo,
            }
    except Exception:
        pass

    try:
        import yfinance as yf
        df = await asyncio.to_thread(
            yf.download, symbol, period="1y", interval="1d", progress=False, auto_adjust=True
        )
        if df is not None and not df.empty and "Close" in df:
            s = df["Close"].dropna().astype(float)
            hi = float(s.max()) if len(s) else None
            lo = float(s.min()) if len(s) else None
            if hi is not None and lo is not None:
                return {
                    "ticker": symbol,
                    "high_52w": hi, "low_52w": lo,
                    "high": hi, "low": lo,
                    "high52": hi, "low52": lo,
                }
    except Exception:
        pass

    return {
        "ticker": symbol,
        "high_52w": None, "low_52w": None,
        "high": None, "low": None,
        "high52": None, "low52": None,
    }

# ----------------------- Movers (Top gainers/losers) -----------------------
@router.get("/movers", summary="Movers")
async def movers():
    """
    Returns normalized gainers/losers with display-safe %:
      { "gainers": [...], "losers": [...], "source": "alphavantage|fallback-local" }
    """
    key = os.getenv("ALPHAVANTAGE_API_KEY")
    out_gainers: List[Dict[str, Any]] = []
    out_losers: List[Dict[str, Any]] = []
    used_source = "alphavantage"

    # ---- 1) Alpha Vantage fast path ----
    if key:
        try:
            url = "https://www.alphavantage.co/query"
            params = {"function": "TOP_GAINERS_LOSERS", "apikey": key}
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(url, params=params)
                data = r.json() if r.content else {}

            gainers_raw = data.get("top_gainers") or []
            losers_raw  = data.get("top_losers")  or []

            out_gainers = [_alpha_to_common(x) for x in gainers_raw][:25]
            out_losers  = [_alpha_to_common(x) for x in losers_raw][:25]

            # normalize + clamp
            out_gainers = [_normalize_tile_row(x) for x in out_gainers]
            out_losers  = [_normalize_tile_row(x) for x in out_losers]

            # accept if looks sane
            if any(isinstance(x.get("price"), (int, float)) for x in out_gainers + out_losers):
                return {"gainers": out_gainers, "losers": out_losers, "source": used_source}
        except Exception:
            pass  # fall through to local fallback

    # ---- 2) Local fallback with hard budget ----
    used_source = "fallback-local"
    universe = _universe_from_env()[:96]  # cap to keep it snappy

    async def compute_row(sym: str) -> Optional[Dict[str, Any]]:
        # Try quote first
        try:
            q = await asyncio.wait_for(asyncio.to_thread(get_quote, sym), timeout=1.5)
            price = _to_float(q.get("current_price"))
            last  = _to_float(q.get("last_close"))
            pct   = _to_float(q.get("change_pct"))
            if (pct is None or pct == 0.0) and price is not None and last:
                pct = ((price - last) / last) * 100.0
            chg = None
            if price is not None and last is not None:
                chg = price - last
            if isinstance(price, float) and isinstance(pct, float):
                return {"symbol": sym, "price": price, "change": chg, "change_pct": pct}
        except Exception:
            pass

        # Then try last two closes
        try:
            closes = await asyncio.wait_for(asyncio.to_thread(get_daily_closes, sym, 3), timeout=1.5)
            closes = [float(x) for x in closes if isinstance(x, (int, float, str))]
            if len(closes) >= 2:
                last = float(closes[-1]); prev = float(closes[-2])
                chg = last - prev
                pct = (chg / prev) * 100.0 if prev else 0.0
                return {"symbol": sym, "price": last, "change": chg, "change_pct": pct}
        except Exception:
            pass
        return None

    tasks = [asyncio.create_task(compute_row(s)) for s in universe]
    done, pending = await asyncio.wait(tasks, timeout=7.5)
    rows: List[Dict[str, Any]] = []
    for t in done:
        try:
            r = t.result()
            if r and isinstance(r.get("price"), float):
                rows.append(r)
        except Exception:
            pass
    for p in pending:
        p.cancel()

    if rows:
        rows.sort(key=lambda x: (x.get("change_pct") or 0.0), reverse=True)
        gainers = rows[:25]
        losers = list(reversed(rows[-25:] if len(rows) >= 25 else rows[:25]))
    else:
        gainers, losers = [], []

    # normalize + clamp
    out_gainers = [_normalize_tile_row(x) for x in gainers]
    out_losers  = [_normalize_tile_row(x) for x in losers]

    return {"gainers": out_gainers, "losers": out_losers, "source": used_source, "partial": bool(done)}

@router.get("/top_gainers", summary="Top Gainers")
async def top_gainers():
    res = await movers()
    return res.get("gainers", [])

@router.get("/top_losers", summary="Top Losers")
async def top_losers():
    res = await movers()
    return res.get("losers", [])
