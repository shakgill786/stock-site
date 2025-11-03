# backend/app/routes.py
from fastapi import APIRouter, Query
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple, Optional
import random, json, asyncio, time, os, math
from datetime import date, datetime, timedelta, timezone
from starlette.responses import StreamingResponse
import httpx

from app.services.finance_service import (
    get_quote,
    get_earnings,
    get_market_breadth,
    get_daily_closes_with_dates,
    get_daily_closes,  # used by movers fallback + predict() fallback
    get_52w_stats,
    get_dividends,     # dividends endpoint
)

router = APIRouter()

# ----------------------- normalization / clamping -----------------------
CLAMP_PCT_BOUNDS: Tuple[float, float] = (-25.0, 25.0)  # UI sanity window
HARD_LAST_MULTIPLIER = 1.95  # reject last beyond ±95% of prevClose (vendor glitch)

def _to_float(x):
    try:
        s = str(x).strip().replace("%", "").replace(",", "")
        v = float(s)
        if math.isfinite(v):
            return v
        return None
    except Exception:
        return None

def _safe_pct(last: Optional[float], prev: Optional[float]) -> float:
    try:
        if last is None or prev is None:
            return 0.0
        if not isinstance(last, (int, float)) or not isinstance(prev, (int, float)):
            return 0.0
        if prev == 0 or math.isnan(last) or math.isnan(prev):
            return 0.0
        return ((float(last) - float(prev)) / float(prev)) * 100.0
    except Exception:
        return 0.0

def _normalize_tile_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize a movers/top_gainers/top_losers row.
    Output keys include:
      - change_pct (display-safe, clamped)
      - change_pct_raw (original vendor pct if provided / computed)
      - display_change (display $ change aligned to clamped %)
      - change_raw (raw $ change before clamping; kept for UI compatibility)
    """
    sym = str(row.get("symbol") or row.get("ticker") or "").upper()
    price = _to_float(row.get("price"))
    chg   = _to_float(row.get("change"))
    pct   = _to_float(row.get("change_pct"))

    prev = None
    if price is not None and chg is not None:
        prev = price - chg

    normalized_reason: List[str] = []
    was_clamped = False

    # Fill missing percent from price/prev if possible
    if pct is None:
        pct = _safe_pct(price, prev)
        normalized_reason.append("computed_percent_from_prices")

    # Some vendors send "dollars" in % field by mistake
    if pct is not None and abs(pct) > 60 and prev and prev != 0:
        as_dollars_pct = (pct / prev) * 100.0
        if abs(as_dollars_pct) <= 60:
            chg = pct
            pct = _safe_pct(price, prev)
            normalized_reason.append("vendor_percent_was_dollars")

    # If current price looks off vs prev, recompute implied price from change
    if prev and price and (price <= (1 - HARD_LAST_MULTIPLIER) * prev or price >= HARD_LAST_MULTIPLIER * prev):
        if chg is not None:
            recomputed_last = prev + chg
            if abs(_safe_pct(recomputed_last, prev)) < abs(_safe_pct(price, prev)):
                price = recomputed_last
                pct = _safe_pct(price, prev)
                normalized_reason.append("recomputed_last_from_change")

    if prev and pct is not None and chg is None:
        chg = (pct / 100.0) * prev

    lb, ub = CLAMP_PCT_BOUNDS
    pct_raw = pct
    if pct is not None and pct < lb:
        pct = lb
        was_clamped = True
    elif pct is not None and pct > ub:
        pct = ub
        was_clamped = True

    base_for_delta = prev if prev is not None else price
    chg_display = ((pct or 0.0) / 100.0 * base_for_delta) if (base_for_delta is not None and pct is not None) else chg

    return {
        "symbol": sym,
        "price": price,
        "change": chg,
        "change_raw": chg,  # keep raw $ change for any legacy UI code
        "change_pct": round(pct or 0.0, 4),
        "change_pct_raw": pct_raw,
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

    if pct is not None and abs(pct) > 60 and last and last != 0:
        as_dollars_pct = (pct / last) * 100.0
        if abs(as_dollars_pct) <= 60:
            pct = _safe_pct(price, last)
            reasons.append("vendor_percent_was_dollars")

    if last and price and (price <= (1 - HARD_LAST_MULTIPLIER) * last or price >= HARD_LAST_MULTIPLIER * last):
        chg = _to_float(out.get("change"))
        if chg is not None:
            recomputed = last + chg
            if abs(_safe_pct(recomputed, last)) < abs(_safe_pct(price, last)):
                price = recomputed
                reasons.append("recomputed_last_from_change")

    lb, ub = CLAMP_PCT_BOUNDS
    pct_raw = pct
    if pct is not None and pct < lb:
        pct = lb; was_clamped = True
    elif pct is not None and pct > ub:
        pct = ub; was_clamped = True

    out["current_price"] = price
    out["last_close"] = last
    out["change_pct_raw"] = pct_raw
    out["change_pct"] = round((pct or 0.0), 4)
    out["display_change_pct"] = round((pct or 0.0), 4)
    base = last if last else price or 0.0
    out["display_change"] = round(((pct or 0.0) / 100.0) * base, 4)
    out["normalized"] = bool(reasons or was_clamped)
    out["normalized_reason"] = "|".join(reasons) if reasons else None
    out["was_clamped"] = was_clamped
    out["clamp_bounds"] = {"min": lb, "max": ub} if was_clamped else None
    return out

# ----------------------- helpers -----------------------
def _is_crypto(symbol: str) -> bool:
    return "-" in (symbol or "").upper()  # BTC-USD etc.

def _filter_equity_calendar(dates: List[str], closes: List[float]) -> Tuple[List[str], List[float]]:
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

        dow = dt.weekday()
        if dow >= 5:
            continue
        if ds == today_iso and out_d:
            continue
        out_d.append(ds)
        out_c.append(float(c))

    if not out_d and dates and closes:
        ds = str(dates[-1])[:10]
        return [ds], [float(closes[-1])]

    return out_d, out_c

async def _pin_last_close_async(symbol: str, dates: List[str], closes: List[float]) -> None:
    if not dates or not closes or _is_crypto(symbol):
        return
    try:
        q = await asyncio.to_thread(get_quote, symbol)
        last_close = q.get("last_close")
        if last_close is not None and math.isfinite(float(last_close)):
            closes[-1] = float(last_close)
    except Exception:
        pass

def _norm_symbol(s: str) -> str:
    return (s or "").strip().upper()

def _alpha_to_common(item: dict) -> dict:
    sym = _norm_symbol(item.get("ticker") or item.get("symbol"))
    price = _to_float(item.get("price"))
    change = _to_float(item.get("change_amount"))
    change_pct = _to_float(item.get("change_percentage"))
    name = item.get("ticker") or sym
    return {"symbol": sym, "price": price, "change": change, "change_pct": change_pct, "name": name}

def _this_week_range() -> Tuple[str, str]:
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    return monday.isoformat(), sunday.isoformat()

_FALLBACK_UNIVERSE = [
    "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","NFLX","AMD",
    "JPM","V","MA","XOM","CVX","WMT","HD","PG","KO","PEP",
    "UNH","JNJ","LLY","PFE","BAC","C","GS","MS","CSCO","ORCL",
    "ADBE","CRM","QCOM","TXN","INTC","T","V","VZ","DIS","NKE","COST",
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

# ----------------------- predictions -----------------------
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
    symbol = req.ticker.upper().strip()

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
        base = 100.0

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

@router.get("/dividends", summary="Dividends Endpoint")
async def dividends_endpoint(ticker: str):
    return await asyncio.to_thread(get_dividends, ticker)

@router.get("/market", summary="Market Endpoint")
async def market_endpoint():
    """
    Always return { items: [...] } with normalized rows.
    """
    data = await asyncio.to_thread(get_market_breadth)
    items_in = []
    if isinstance(data, dict):
        if isinstance(data.get("items"), list):
            items_in = data["items"]
        else:
            # If a dict mapping symbols → objects leaks through, convert to list.
            for k, v in (data or {}).items():
                if isinstance(v, dict):
                    items_in.append({
                        "symbol": k,
                        "price": v.get("current_price") or v.get("last"),
                        "change": v.get("change"),
                        "change_pct": v.get("change_pct") or v.get("percent"),
                    })
    # Normalize rows for UI safety
    items = []
    for r in items_in:
        row = {
            "symbol": r.get("symbol") or r.get("ticker"),
            "price": r.get("price") or r.get("current_price"),
            "change": r.get("change"),
            "change_pct": r.get("change_pct"),
        }
        items.append(_normalize_tile_row(row))
    return {"items": items, "ts": int(time.time() * 1000)}

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
                    "change_pct": q.get("change_pct"),
                    "ts": int(time.time()),
                }
                yield f"data: {json.dumps(payload)}\n\n"
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            return

    return StreamingResponse(event_gen(), media_type="text/event-stream")

# ----------------------- Closes for charts -----------------------
@router.get("/closes", summary="Closes Endpoint")
async def closes_endpoint(ticker: str, days: int = 60):
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

# ----------------------- Quick stats -----------------------
@router.get("/stats", summary="Stats Endpoint")
async def stats_endpoint(ticker: str):
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

async def _last_two_closes(sym: str) -> Optional[Tuple[float, float]]:
    """
    Return (last_close, prev_close) with a generous timeout + yfinance fallback.
    This fixes the '0.00%' issue when quotes are stale and closes fetch is slow.
    """
    # A) Provider with dates (preferred)
    try:
        series = await asyncio.wait_for(
            asyncio.to_thread(get_daily_closes_with_dates, sym, 4),
            timeout=4.5,  # was ~1.5 — too tight on Render
        )
        closes = series.get("closes") or []
        closes = [float(x) for x in closes if _to_float(x) is not None]
        if len(closes) >= 2:
            return float(closes[-1]), float(closes[-2])
    except Exception:
        pass

    # B) Simple closes (second try)
    try:
        closes = await asyncio.wait_for(asyncio.to_thread(get_daily_closes, sym, 4), timeout=4.5)
        closes = [float(x) for x in closes if _to_float(x) is not None]
        if len(closes) >= 2:
            return float(closes[-1]), float(closes[-2])
    except Exception:
        pass

    # C) yfinance (final safety net)
    try:
        import yfinance as yf
        df = await asyncio.to_thread(
            yf.download, sym, period="7d", interval="1d", progress=False, auto_adjust=True
        )
        if df is not None and not df.empty and "Close" in df:
            s = df["Close"].dropna().astype(float)
            if len(s) >= 2:
                return float(s.iloc[-1]), float(s.iloc[-2])
    except Exception:
        pass

    return None

@router.get("/movers", summary="Movers")
async def movers():
    """
    Returns normalized gainers/losers with display-safe % based on **EOD calibration**:
      - Prefer last_close vs prev_close from daily closes
      - Fall back to quote when closes unavailable
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

            out_gainers = [_normalize_tile_row(x) for x in out_gainers]
            out_losers  = [_normalize_tile_row(x) for x in out_losers]

            if any(isinstance(x.get("price"), (int, float)) for x in out_gainers + out_losers):
                return {"gainers": out_gainers, "losers": out_losers, "source": used_source}
        except Exception:
            pass  # fall through to local fallback

    # ---- 2) Local fallback with EOD-calibrated change ----
    used_source = "fallback-local"
    universe = _universe_from_env()[:96]

    async def compute_row(sym: str) -> Optional[Dict[str, Any]]:
        """
        Strategy:
          A) Try quote quickly.
          B) If quote looks stale (pct≈0 or price==last) or missing → compute EOD % from last two closes.
          C) If closes unavailable, use quote-derived % as last resort.
        """
        price = last = pct = chg = None

        # A) Quote first (low-latency)
        try:
            q = await asyncio.wait_for(asyncio.to_thread(get_quote, sym), timeout=1.2)
            price = _to_float(q.get("current_price"))
            last  = _to_float(q.get("last_close"))
            pct   = _to_float(q.get("change_pct"))

            # Stale if pct ~ 0 OR price == last
            is_stale = (pct is None or abs(pct) < 0.01) or (
                price is not None and last is not None and abs(price - last) < 1e-9
            )

            if not is_stale and price is not None and last is not None:
                chg = price - last
                if pct is None:
                    pct = _safe_pct(price, last)
        except Exception:
            pass

        # B) Prefer EOD closes if quote stale or incomplete
        need_eod = (
            pct is None or abs(pct) < 0.01 or last is None or price is None or
            (price is not None and last is not None and abs(price - last) < 1e-9)
        )
        if need_eod:
            twc = await _last_two_closes(sym)
            if twc:
                last_c, prev_c = twc
                if prev_c and last_c:
                    chg_eod = last_c - prev_c
                    pct_eod = (chg_eod / prev_c) * 100.0 if prev_c != 0 else 0.0
                    return {"symbol": sym, "price": last_c, "change": chg_eod, "change_pct": pct_eod}

        # C) Fall back to quote-derived if we have it
        if price is not None and last is not None:
            if pct is None:
                pct = _safe_pct(price, last)
            if chg is None:
                chg = price - last
            return {"symbol": sym, "price": price, "change": chg, "change_pct": pct}

        return None

    tasks = [asyncio.create_task(compute_row(s)) for s in universe]
    done, pending = await asyncio.wait(tasks, timeout=8.0)  # was 7.5
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

# ======================= Sentiment =======================
def _iso_date(s: str) -> str:
    return str(s)[:10]

def _utc_now():
    return datetime.now(timezone.utc)

async def _fetch_av_news_sentiment(symbol: str, days: int) -> List[Dict[str, Any]]:
    """
    Alpha Vantage NEWS_SENTIMENT; aggregates by day for the specific ticker.
    Returns: [{"date": "YYYY-MM-DD", "mean": float, "n": int}]
    """
    key = os.getenv("ALPHAVANTAGE_API_KEY")
    if not key:
        return []

    # Alpha Vantage wants time_from like 20240101T0000
    start = _utc_now() - timedelta(days=max(1, days + 14))  # widen to catch weekends/holidays
    time_from = start.strftime("%Y%m%dT0000")

    params = {
        "function": "NEWS_SENTIMENT",
        "tickers": symbol.upper(),
        "time_from": time_from,
        "sort": "LATEST",
        "apikey": key,
        "limit": 2000,  # cap
    }

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get("https://www.alphavantage.co/query", params=params)
            data = r.json() if r.content else {}
    except Exception:
        return []

    feed = data.get("feed") or []
    if not isinstance(feed, list) or not feed:
        return []

    # Collect ticker-specific scores
    buckets: Dict[str, List[float]] = {}
    for item in feed:
        ts = item.get("time_published")  # "20240618T133500"
        if not ts or len(ts) < 8:
            continue
        d_iso = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}"

        scores = []
        for t in item.get("ticker_sentiment", []) or []:
            if _norm_symbol(t.get("ticker")) == symbol.upper():
                s = _to_float(t.get("ticker_sentiment_score"))
                if isinstance(s, float):
                    scores.append(s)

        if not scores:
            s = _to_float(item.get("overall_sentiment_score"))
            if isinstance(s, float):
                scores.append(s)

        if scores:
            buckets.setdefault(d_iso, []).extend(scores)

    out: List[Dict[str, Any]] = []
    for d_iso, arr in buckets.items():
        if not arr:
            continue
        m = sum(arr) / len(arr)
        out.append({"date": d_iso, "mean": float(m), "n": int(len(arr))})

    out.sort(key=lambda x: x["date"])
    return out[-days:] if days and len(out) > days else out

async def _fetch_av_news_raw(symbol: str, limit: int = 80) -> List[Dict[str, Any]]:
    """
    Minimal raw news fetch/normalize from Alpha Vantage NEWS_SENTIMENT feed.
    """
    key = os.getenv("ALPHAVANTAGE_API_KEY")
    if not key:
        return []

    start = _utc_now() - timedelta(days=30)
    time_from = start.strftime("%Y%m%dT0000")
    params = {
        "function": "NEWS_SENTIMENT",
        "tickers": symbol.upper(),
        "time_from": time_from,
        "sort": "LATEST",
        "apikey": key,
        "limit": max(1, min(int(limit), 2000)),
    }

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get("https://www.alphavantage.co/query", params=params)
            data = r.json() if r.content else {}
    except Exception:
        return []

    feed = data.get("feed") or []
    out = []
    for it in feed:
        ts = it.get("time_published") or ""
        d_iso = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}" if len(ts) >= 8 else None
        score = _to_float(it.get("overall_sentiment_score"))
        # pick per-ticker score if available
        tscore = None
        for t in it.get("ticker_sentiment", []) or []:
            if _norm_symbol(t.get("ticker")) == symbol.upper():
                tscore = _to_float(t.get("ticker_sentiment_score"))
                break
        out.append({
            "title": it.get("title"),
            "url": it.get("url"),
            "source": it.get("source"),
            "published": d_iso,
            "overall_score": score,
            "ticker_score": tscore,
        })
    return out

def _pearson(xs: List[float], ys: List[float]) -> Optional[float]:
    n = min(len(xs), len(ys))
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    denx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    deny = math.sqrt(sum((y - my) ** 2 for y in ys))
    if denx == 0 or deny == 0:
        return None
    return num / (denx * deny)

@router.get("/sentiment/daily", summary="Daily mean sentiment")
async def sentiment_daily(ticker: str, limit: int = 120):
    symbol = _norm_symbol(ticker)
    daily = await _fetch_av_news_sentiment(symbol, limit)
    return {"ticker": symbol, "daily": daily}

@router.get("/sentiment/news", summary="Raw news (simplified) for ticker")
async def sentiment_news(ticker: str, limit: int = 80):
    symbol = _norm_symbol(ticker)
    items = await _fetch_av_news_raw(symbol, limit)
    return {"ticker": symbol, "items": items}

@router.get("/sentiment/correlation", summary="Sentiment vs next-day return")
async def sentiment_correlation(ticker: str, days: int = 120):
    symbol = _norm_symbol(ticker)
    days = max(10, min(int(days), 365))

    # 1) Prices with dates
    try:
        series = await asyncio.wait_for(
            asyncio.to_thread(get_daily_closes_with_dates, symbol, days + 60),
            timeout=10.0,
        )
    except Exception:
        series = {"dates": [], "closes": []}

    dates: List[str] = list(series.get("dates") or [])
    closes: List[float] = list(series.get("closes") or [])

    if not dates or not closes or len(dates) != len(closes):
        return {"ticker": symbol, "daily": [], "closes_dates": [], "closes": [], "correlation": {"pearson_r": None, "n": 0, "pairs": []}}

    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)

    # 2) News sentiment, daily mean
    daily_sent = await _fetch_av_news_sentiment(symbol, days)

    # 3) Build next-day returns aligned to price dates (same-or-next trading day)
    def first_index_on_or_after(target_iso: str) -> int:
        lo, hi = 0, len(dates) - 1
        ans = -1
        while lo <= hi:
            mid = (lo + hi) // 2
            cur = str(dates[mid])[:10]
            if cur >= target_iso:
                ans = mid
                hi = mid - 1
            else:
                lo = mid + 1
        return ans

    pairs: List[Dict[str, Any]] = []
    for row in daily_sent:
        d = _iso_date(row["date"])
        j = first_index_on_or_after(d)
        if j is None or j < 0:
            continue
        if j + 1 >= len(closes):
            continue
        c0 = float(closes[j]); c1 = float(closes[j + 1])
        if c0 <= 0:
            continue
        ret = (c1 - c0) / c0
        pairs.append({"date": d, "price_date": str(dates[j])[:10], "sent": float(row["mean"]), "ret": float(ret)})

    if not pairs:
        return {
            "ticker": symbol,
            "days": days,
            "daily": daily_sent,
            "closes_dates": [str(d)[:10] for d in dates],
            "closes": closes,
            "correlation": {"pearson_r": None, "n": 0, "pairs": []},
        }

    xs = [p["sent"] for p in pairs]
    ys = [p["ret"] for p in pairs]
    r = _pearson(xs, ys)

    return {
        "ticker": symbol,
        "days": days,
        "daily": daily_sent,
        "closes_dates": [str(d)[:10] for d in dates],
        "closes": closes,
        "correlation": {"pearson_r": r, "n": len(pairs), "pairs": pairs},
    }

@router.get("/sentiment/correlate", summary="Alias to /sentiment/correlation")
async def sentiment_correlate(ticker: str, days: int = 120):
    return await sentiment_correlation(ticker=ticker, days=days)
