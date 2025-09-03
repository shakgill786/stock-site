# backend/app/routes.py
from fastapi import APIRouter, Query
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple, Optional
import random, json, asyncio, time, os
from datetime import date, datetime, timedelta
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

# ----------------------- helpers -----------------------
def _is_crypto(symbol: str) -> bool:
    return "-" in (symbol or "").upper()  # BTC-USD etc.

def _filter_equity_calendar(dates: List[str], closes: List[float]) -> Tuple[List[str], List[float]]:
    """
    Drop weekends and 'today' for equities so we keep only completed trading days.
    Assumes dates are ISO strings (YYYY-MM-DD), most-recent last.
    """
    if not dates or not closes or len(dates) != len(closes):
        return dates or [], closes or []

    today_iso = date.today().isoformat()
    out_d, out_c = [], []
    for d, c in zip(dates, closes):
        try:
            dt = date.fromisoformat(str(d)[:10])
        except Exception:
            out_d.append(str(d)[:10]); out_c.append(float(c))
            continue

        dow = dt.weekday()  # 0=Mon..6=Sun
        if dow >= 5 or dt.isoformat() == today_iso:  # weekend or today
            continue
        out_d.append(dt.isoformat()); out_c.append(float(c))
    return out_d, out_c

def _pin_last_close(symbol: str, dates: List[str], closes: List[float]) -> None:
    """For equities, replace the last close with quote.last_close for consistency."""
    if not dates or not closes or _is_crypto(symbol):
        return
    try:
        q = get_quote(symbol)
        last_close = float(q.get("last_close"))
        closes[-1] = last_close
    except Exception:
        pass

def _normalize_models_param(models: Optional[List[str]]) -> List[str]:
    """
    Accepts: None, ["LSTM","ARIMA"], ["LSTM,ARIMA"] (comma string)
    Case-insensitive; maps RF->RandomForest, XGB->XGBoost.
    """
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

def _this_week_range() -> Tuple[str, str]:
    """Mon..Sun ISO range for the current week (local time)."""
    today = date.today()
    monday = today - timedelta(days=today.weekday())  # 0=Mon
    sunday = monday + timedelta(days=6)
    return monday.isoformat(), sunday.isoformat()

def _to_float(x):
    try:
        s = str(x).strip().replace("%", "").replace(",", "")
        return float(s)
    except Exception:
        return None

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

# ----------------------- routes -----------------------
@router.get("/hello")
async def say_hello():
    return {"message": "Hello from FastAPI!"}

# ---------- Predictions ----------
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
        q = get_quote(symbol)
        base = float(q.get("current_price"))
    except Exception:
        try:
            closes = get_daily_closes(symbol, 5)
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
@router.get("/predict_history")
async def predict_history(
    ticker: str,
    days: int = 12,  # last ~2 weeks of trading days
    models: List[str] = Query(default=None),
):
    """
    For each of the last `days` TARGET DATES (most-recent last), return:
      - actual close on that date
      - what each model would have predicted for that date using only data up to the prior trading day
    """
    symbol = str(ticker).upper()
    days = max(1, min(int(days), 60))
    models = _normalize_models_param(models)

    series = get_daily_closes_with_dates(symbol, days + 40)
    dates: List[str] = list(series.get("dates") or [])
    closes: List[float] = list(series.get("closes") or [])

    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)

    n = len(closes)
    if n < 2:
        return {"ticker": symbol, "models": models, "rows": []}

    _pin_last_close(symbol, dates, closes)

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

        row = {
            "date": target_date,
            "close": round(actual, 2),
            "actual": round(actual, 2),
            "pred": pred_map,
            "error_pct": err_map,
            **flat,
            **flat_err,
        }
        rows.append(row)

    return {"ticker": symbol, "models": models, "rows": rows}

# ---------- Quote / Earnings / Market ----------
@router.get("/quote")
async def quote_endpoint(ticker: str):
    return get_quote(ticker)

@router.get("/earnings")
async def earnings_endpoint(ticker: str):
    return get_earnings(ticker)

@router.get("/market")
async def market_endpoint():
    return get_market_breadth()

# ---------- Live quote stream (SSE) ----------
@router.get("/quote_stream")
async def quote_stream(ticker: str, interval: float = 5.0):
    interval = max(1.0, min(float(interval), 60.0))

    async def event_gen():
        try:
            while True:
                q = get_quote(ticker)
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

# ---------- Closes for charts (dates + up to 5y) ----------
@router.get("/closes")
async def closes_endpoint(ticker: str, days: int = 60):
    """
    Returns up to ~5 years of daily closes with aligned ISO dates, most-recent last.
    { "ticker": "AAPL", "dates": [...], "closes": [...] }
    """
    symbol = str(ticker).upper()
    days = max(2, min(int(days), 1825))
    data = get_daily_closes_with_dates(symbol, days)
    dates: List[str] = list(data.get("dates") or [])
    closes: List[float] = list(data.get("closes") or [])

    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)
        _pin_last_close(symbol, dates, closes)

    return {"ticker": symbol, "dates": dates, "closes": closes}

# ---------- Quick stats (52w high/low only) ----------
@router.get("/stats")
async def stats_endpoint(ticker: str):
    """
    Returns 52-week stats. Tries service; if missing/invalid, computes from yfinance.
    Also provides alias keys: high, low, high52, low52 (for UI compatibility).
    """
    symbol = str(ticker).upper()

    # Try service first
    try:
        stats = get_52w_stats(symbol) or {}
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

    # Fallback: compute from yfinance (last ~1y closes, adjusted)
    try:
        import yfinance as yf
        df = yf.download(symbol, period="1y", interval="1d", progress=False, auto_adjust=True)
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

    # As a last resort, placeholders
    return {
        "ticker": symbol,
        "high_52w": None, "low_52w": None,
        "high": None, "low": None,
        "high52": None, "low52": None,
    }

# ---------- Movers (Top gainers/losers) ----------
@router.get("/movers")
async def movers():
    """
    Returns both gainers and losers:
    { "gainers": [...], "losers": [...] }
    Strategy:
      1) Try Alpha Vantage TOP_GAINERS_LOSERS (fast when available)
      2) Fallback with a hard time budget:
         - Cap universe size
         - For each symbol: try get_quote (2.5s), else get_daily_closes(3) (2.5s)
         - Overall wall time capped (~12s)
    Always returns quickly with best-effort partial data.
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
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(url, params=params)
                data = r.json() if r.content else {}

            gainers_raw = data.get("top_gainers") or []
            losers_raw  = data.get("top_losers")  or []

            out_gainers = [_alpha_to_common(x) for x in gainers_raw][:25]
            out_losers  = [_alpha_to_common(x) for x in losers_raw][:25]

            def _valid(rows):
                k = 0
                for x in rows:
                    if isinstance(x.get("price"), (int, float)) and isinstance(x.get("change_pct"), (int, float)):
                        k += 1
                    if k >= 5:
                        return True
                return False

            if _valid(out_gainers) or _valid(out_losers):
                return {"gainers": out_gainers, "losers": out_losers, "source": used_source}
        except Exception:
            pass  # fall through to local fallback

    # ---- 2) Local fallback with hard budget ----
    used_source = "fallback-local"
    universe = _universe_from_env()[:96]  # cap to keep it snappy

    async def compute_row(sym: str) -> Optional[Dict[str, Any]]:
        # Try quote first (fast, includes intraday change)
        try:
            q = await asyncio.wait_for(asyncio.to_thread(get_quote, sym), timeout=2.5)
            price = float(q.get("current_price"))
            last  = float(q.get("last_close"))
            pct   = float(q.get("change_pct"))
            chg = None
            try:
                chg = price - last
            except Exception:
                pass
            if isinstance(price, float) and isinstance(pct, float):
                return {"symbol": sym, "price": price, "change": chg, "change_pct": pct}
        except Exception:
            pass

        # Then try last two historical closes (very reliable)
        try:
            closes = await asyncio.wait_for(asyncio.to_thread(get_daily_closes, sym, 3), timeout=2.5)
            closes = [float(x) for x in closes if isinstance(x, (int, float, str))]
            if len(closes) >= 2:
                last = float(closes[-1])
                prev = float(closes[-2])
                if prev and prev != 0:
                    chg = last - prev
                    pct = (chg / prev) * 100.0
                else:
                    chg, pct = 0.0, 0.0
                return {"symbol": sym, "price": last, "change": chg, "change_pct": pct}
        except Exception:
            pass

        return None

    # make tasks and enforce overall wall-time budget
    tasks = [asyncio.create_task(compute_row(s)) for s in universe]
    done, pending = await asyncio.wait(tasks, timeout=12.0)
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

    # rank and split
    if rows:
        rows.sort(key=lambda x: (x.get("change_pct") or 0.0), reverse=True)
        out_gainers = rows[:25]
        out_losers = list(reversed(rows[-25:] if len(rows) >= 25 else rows[:25]))
    else:
        out_gainers, out_losers = [], []

    return {"gainers": out_gainers, "losers": out_losers, "source": used_source, "partial": bool(done)}

@router.get("/top_gainers")
async def top_gainers():
    res = await movers()
    return res.get("gainers", [])

@router.get("/top_losers")
async def top_losers():
    res = await movers()
    return res.get("losers", [])

# ---------- Earnings Calendar (this week) ----------
@router.get("/earnings_week")
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
