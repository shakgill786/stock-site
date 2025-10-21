# app/routes.py
from fastapi import APIRouter, Query
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple, Optional
import random, json, asyncio, time, os, math, statistics
from datetime import date, timedelta, datetime
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
SENTIMENT_ALERT_ABS_THRESHOLD = 0.35  # "strong" daily mean VADER score

def _to_float(x):
    try:
        s = str(x).strip().replace("%", "").replace(",", "")
        return float(s)
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
    Normalize a movers/top_gainers/top_losers row to avoid goofy values like +140.75%:
      - compute percent from price & last if vendor percent is missing/bad
      - fix 'percent' that is actually dollars
      - clamp % to ±25 for DISPLAY (keep originals as *_raw)
    Expected keys: symbol, price, change, change_pct (best-effort)
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

    # heuristic: vendor returned dollars in percent field
    if abs(pct) > 60 and prev and prev != 0:
        as_dollars_pct = (pct / prev) * 100.0
        if abs(as_dollars_pct) <= 60:
            chg = pct
            pct = _safe_pct(price, prev)
            normalized_reason.append("vendor_percent_was_dollars")

    # price vs prev sanity
    if prev and price and (price <= (1 - HARD_LAST_MULTIPLIER) * prev or price >= HARD_LAST_MULTIPLIER * prev):
        if chg is not None:
            recomputed_last = prev + chg
            if abs(_safe_pct(recomputed_last, prev)) < abs(_safe_pct(price, prev)):
                price = recomputed_last
                pct = _safe_pct(price, prev)
                normalized_reason.append("recomputed_last_from_change")

    # final consistency: if only pct present, synthesize $ change
    if prev and pct is not None and chg is None:
        chg = (pct / 100.0) * prev

    # DISPLAY clamp
    lb, ub = CLAMP_PCT_BOUNDS
    pct_raw = pct if pct is not None else 0.0
    pct_display = pct_raw
    if pct_display < lb:
        pct_display = lb; was_clamped = True
    elif pct_display > ub:
        pct_display = ub; was_clamped = True

    chg_display = ((pct_display / 100.0) * (prev if prev else price)) if (prev or price) else chg

    # IMPORTANT: we return both:
    # - change_pct_raw: vendor/original (may be wrong)
    # - change_pct:     CLAMPED display value for your frontend
    return {
        "symbol": sym,
        "price": price,
        "change": chg,
        "change_pct_raw": pct_raw,
        "change_pct": round(pct_display, 4),  # <-- frontend should read THIS
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
        pct = _safe_pct(price, last)
        reasons.append("vendor_percent_was_dollars")

    # hard sanity for 'price' vs last
    if last and price and (price <= (1 - HARD_LAST_MULTIPLIER) * last or price >= HARD_LAST_MULTIPLIER * last):
        chg = _to_float(out.get("change"))
        if chg is not None:
            recomputed = last + chg
            if abs(_safe_pct(recomputed, last)) < abs(_safe_pct(price, last)):
                price = recomputed
                reasons.append("recomputed_last_from_change")

    # display clamp
    lb, ub = CLAMP_PCT_BOUNDS
    pct_raw = pct
    pct_display = pct_raw
    if pct_display < lb:
        pct_display = lb; was_clamped = True
    elif pct_display > ub:
        pct_display = ub; was_clamped = True

    out["current_price"] = price
    out["last_close"] = last
    out["change_pct_raw"] = pct_raw
    out["display_change_pct"] = round(pct_display, 4)
    out["display_change"] = round(((pct_display / 100.0) * (last if last else price or 0.0)), 4)
    out["normalized"] = bool(reasons or was_clamped)
    out["normalized_reason"] = "|".join(reasons) if reasons else None
    out["was_clamped"] = was_clamped
    out["clamp_bounds"] = {"min": lb, "max": ub} if was_clamped else None
    return out

# ----------------------- helpers -----------------------
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

def _this_week_range() -> Tuple[str, str]:
    """Mon..Sun ISO range for the current week (local time)."""
    today = date.today()
    monday = today - timedelta(days=today.weekday())  # 0=Mon
    sunday = monday + timedelta(days=6)
    return monday.isoformat(), sunday.isoformat()

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

def _apply_display_mapping(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Ensure downstream cards that read `change_pct` see the display-safe value.
    Keep the unmodified vendor percent in `change_pct_raw`.
    """
    out = []
    for r in rows:
        # r already has: change_pct (clamped), change_pct_raw, display_change
        o = {
            "symbol": r.get("symbol"),
            "price": r.get("price"),
            "change": r.get("change"),
            "change_pct": r.get("change_pct"),            # clamped for UI
            "change_pct_raw": r.get("change_pct_raw"),    # original
            "display_change": r.get("display_change"),
            "normalized": r.get("normalized"),
            "normalized_reason": r.get("normalized_reason"),
            "was_clamped": r.get("was_clamped"),
            "clamp_bounds": r.get("clamp_bounds"),
        }
        out.append(o)
    return out

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
    Normalize market tiles so percent is safe to display.
    """
    data = await asyncio.to_thread(get_market_breadth)
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        items = []
        for r in data["items"]:
            row = {
                "symbol": r.get("symbol") or r.get("ticker"),
                "price": r.get("price") or r.get("last"),
                "change": r.get("change"),
                "change_pct": r.get("change_pct") or r.get("percent"),
            }
            items.append(_normalize_tile_row(row))
        return {"items": _apply_display_mapping(items), "ts": int(time.time() * 1000)}
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
                    "change_pct": q.get("display_change_pct"),  # display-safe %
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
@router.get("/movers", summary="Movers")
async def movers():
    """
    Returns normalized gainers/losers with display-safe % in `change_pct`:
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

            out_gainers = [_normalize_tile_row(_alpha_to_common(x)) for x in gainers_raw][:25]
            out_losers  = [_normalize_tile_row(_alpha_to_common(x)) for x in losers_raw][:25]

            # accept if looks sane
            if any(isinstance(x.get("price"), (int, float)) for x in out_gainers + out_losers):
                return {
                    "gainers": _apply_display_mapping(out_gainers),
                    "losers": _apply_display_mapping(out_losers),
                    "source": used_source
                }
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
            if isinstance(price, float):
                return _normalize_tile_row({"symbol": sym, "price": price, "change": chg, "change_pct": pct})
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
                return _normalize_tile_row({"symbol": sym, "price": last, "change": chg, "change_pct": pct})
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

    return {
        "gainers": _apply_display_mapping(gainers),
        "losers": _apply_display_mapping(losers),
        "source": used_source,
        "partial": bool(done)
    }

@router.get("/top_gainers", summary="Top Gainers")
async def top_gainers():
    res = await movers()
    return res.get("gainers", [])

@router.get("/top_losers", summary="Top Losers")
async def top_losers():
    res = await movers()
    return res.get("losers", [])

# ----------------------- Earnings Calendar (this week) -----------------------
@router.get("/earnings_week", summary="Earnings Week")
async def earnings_week():
    """
    Returns an array of earnings items for the current week: [{date, symbol, name, session}]
    """
    token = os.getenv("FINNHUB_API_KEY")
    if not token:
        return {"items": [], "error": "FINNHUB_API_KEY missing"}

    start_iso, end_iso = _this_week_range()
    url = "https://finnhub.io/api/v1/calendar/earnings"
    params = {"from": start_iso, "to": end_iso, "token": token}

    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(url, params=params)
        data = r.json() if r.content else {}

    rows = data.get("earningsCalendar") or data.get("earnings") or []
    out: List[Dict[str, Any]] = []
    for it in rows:
        dt = (it.get("date") or it.get("reportDate") or "")[:10]
        sym = _norm_symbol(it.get("symbol") or it.get("ticker"))
        session = (it.get("hour") or it.get("time") or "").upper()
        if session not in {"BMO", "AMC"}:
            session = "UNK"
        name = it.get("company") or it.get("name") or sym
        if sym and dt:
            out.append({"date": dt, "symbol": sym, "name": name, "session": session})

    out.sort(key=lambda x: (x["date"], x["symbol"]))
    return {"items": out[:500]}

# Trailing-slash alias (fixes stray typo in earlier version)
@router.get("/earnings_week/", summary="Earnings Week (alias)")
async def earnings_week_alias():
    return await earnings_week()

# ======================= Sentiment =======================
def _iso_day(ts: str) -> str:
    # Alpha Vantage: "YYYYMMDDTHHMMSS"
    try:
        dt = datetime.strptime(ts[:15], "%Y%m%dT%H%M%S")
        return dt.date().isoformat()
    except Exception:
        try:
            return datetime.fromisoformat(ts[:10]).date().isoformat()
        except Exception:
            return str(ts)[:10]

async def _alpha_news_sentiment_daily_mean(ticker: str, days: int) -> Dict[str, float]:
    """
    Pull Alpha Vantage NEWS_SENTIMENT and compute per-day mean ticker_sentiment_score.
    Returns dict { 'YYYY-MM-DD': mean_score }
    """
    key = os.getenv("ALPHAVANTAGE_API_KEY")
    if not key:
        return {}

    url = "https://www.alphavantage.co/query"
    # AlphaVantage lets multiple pages via 'limit' (soft). We'll just pull a decent chunk.
    params = {"function": "NEWS_SENTIMENT", "tickers": ticker, "apikey": key, "limit": 200}

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(url, params=params)
        data = r.json() if r.content else {}

    feed = data.get("feed") or []
    buckets: Dict[str, List[float]] = {}

    for item in feed:
        day = _iso_day(item.get("time_published", ""))
        if not day:
            continue
        scores = []
        for ts in item.get("ticker_sentiment", []) or []:
            if _norm_symbol(ts.get("ticker")) == _norm_symbol(ticker):
                sc = _to_float(ts.get("ticker_sentiment_score"))
                if isinstance(sc, float):
                    scores.append(sc)
        if not scores:
            # fallback to overall_relevance_score as super light signal
            sc = _to_float(item.get("relevance_score"))
            if isinstance(sc, float):
                scores.append(sc * 0.1)
        if scores:
            buckets.setdefault(day, []).extend(scores)

    # reduce to mean by day, keep only most recent N days that we care about
    days_back = max(10, min(days, 365))
    sorted_days = sorted(buckets.keys())[-days_back:]
    return {d: float(statistics.mean(buckets[d])) for d in sorted_days if buckets.get(d)}

def _pearson(x: List[float], y: List[float]) -> Optional[float]:
    xs = [float(v) for v in x]
    ys = [float(v) for v in y]
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    try:
        mx = statistics.mean(xs); my = statistics.mean(ys)
        num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
        denx = math.sqrt(sum((a - mx) ** 2 for a in xs))
        deny = math.sqrt(sum((b - my) ** 2 for b in ys))
        if denx == 0 or deny == 0:
            return None
        return num / (denx * deny)
    except Exception:
        return None

@router.get("/sentiment/correlation", summary="Daily sentiment vs next-day return")
async def sentiment_correlation(ticker: str, days: int = 120):
    """
    Returns:
    {
      "ticker": "...",
      "daily": [{"date": "YYYY-MM-DD", "mean": float}, ...],
      "closes_dates": [...], "closes": [...],
      "correlation": {"pearson_r": float|None, "pairs": [{"date", "sent", "ret"}]}
    }
    """
    symbol = _norm_symbol(ticker)
    days = max(20, min(int(days), 365))

    # 1) Get closes
    try:
        series = await asyncio.wait_for(
            asyncio.to_thread(get_daily_closes_with_dates, symbol, days + 5),
            timeout=10.0,
        )
    except Exception:
        series = {"dates": [], "closes": []}

    dates: List[str] = list(series.get("dates") or [])
    closes: List[float] = list(series.get("closes") or [])

    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)

    # 2) Sentiment per day (Alpha Vantage NEWS_SENTIMENT)
    sent_by_day = await _alpha_news_sentiment_daily_mean(symbol, days)

    # 3) Build next-day returns aligned to sentiment days
    pairs = []
    by_date_to_close = {str(d)[:10]: float(c) for d, c in zip(dates, closes)}
    for d, s in sent_by_day.items():
        if d not in by_date_to_close:
            continue
        # next trading day = the next date in our closes list
        try:
            idx = dates.index(d)
            if idx + 1 < len(closes):
                prev = closes[idx]
                nxt = closes[idx + 1]
                ret = (nxt - prev) / prev if prev else 0.0
                pairs.append({"date": d, "sent": float(s), "ret": float(ret)})
        except ValueError:
            continue

    pearson_r = None
    if pairs:
        pearson_r = _pearson([p["sent"] for p in pairs], [p["ret"] for p in pairs])

    daily_rows = [{"date": d, "mean": float(m)} for d, m in sorted(sent_by_day.items())]
    return {
        "ticker": symbol,
        "daily": daily_rows,
        "closes_dates": dates,
        "closes": closes,
        "correlation": {"pearson_r": pearson_r, "pairs": pairs},
    }

# Minimal SSE alerts: emits when daily mean sentiment |score| >= threshold
@router.get("/sentiment/alerts_stream", summary="Sentiment alerts stream (SSE)")
async def sentiment_alerts_stream(ticker: str, days: int = 60, interval: float = 30.0):
    symbol = _norm_symbol(ticker)
    interval = max(10.0, min(float(interval), 120.0))

    async def gen():
        try:
            last_emitted_day = None
            while True:
                data = await sentiment_correlation(symbol, days)  # reuse handler
                daily = data.get("daily") or []
                if daily:
                    last = daily[-1]  # most recent day present
                    score = float(last.get("mean") or 0.0)
                    day = str(last.get("date"))
                    level = "strong" if abs(score) >= SENTIMENT_ALERT_ABS_THRESHOLD else "normal"
                    payload = {
                        "ticker": symbol,
                        "date": day,
                        "score": score,
                        "level": level,
                        "ts": int(time.time()),
                    }
                    # emit only if new day or strong reading
                    if day != last_emitted_day or level == "strong":
                        yield f"data: {json.dumps(payload)}\n\n"
                        last_emitted_day = day
                    else:
                        # keep-alive ping
                        yield f"data: {json.dumps({'ticker': symbol, 'keepalive': True, 'ts': int(time.time())})}\n\n"
                else:
                    yield f"data: {json.dumps({'ticker': symbol, 'error': 'no sentiment', 'ts': int(time.time())})}\n\n"
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            return

    return StreamingResponse(gen(), media_type="text/event-stream")
