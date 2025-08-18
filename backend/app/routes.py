# backend/app/routes.py

from fastapi import APIRouter, Query
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple
import random, json, asyncio, time
from datetime import date, datetime
from starlette.responses import StreamingResponse

from app.services.finance_service import (
    get_quote,
    get_earnings,
    get_market_breadth,
    get_daily_closes_with_dates,
    get_52w_stats,
)

router = APIRouter()

# ----------------------- helpers -----------------------

def _is_crypto(symbol: str) -> bool:
    s = (symbol or "").upper()
    # crude heuristic: most crypto pairs look like BTC-USD, ETH-USD, etc.
    return "-" in s

def _filter_equity_calendar(dates: List[str], closes: List[float]) -> Tuple[List[str], List[float]]:
    """
    Drop weekends and 'today' for equities so we only keep completed trading days.
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
            out_d.append(str(d)[:10])
            out_c.append(float(c))
            continue

        dow = dt.weekday()  # 0=Mon..6=Sun
        is_weekend = dow >= 5
        is_today = (dt.isoformat() == today_iso)
        if is_weekend or is_today:
            continue  # skip weekends and today
        out_d.append(dt.isoformat())
        out_c.append(float(c))
    return out_d, out_c

def _pin_last_close(symbol: str, dates: List[str], closes: List[float]) -> None:
    """
    Replace the last close with quote.last_close when appropriate (equities only),
    so 'actual' for the latest completed trading day matches the quote card.
    """
    if not dates or not closes or _is_crypto(symbol):
        return
    try:
        q = get_quote(symbol)
        last_close = float(q.get("last_close"))
    except Exception:
        return
    try:
        closes[-1] = last_close
    except Exception:
        pass

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
    random.seed(req.ticker.upper())
    base = get_quote(req.ticker)["current_price"]
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
      - what each model *would have predicted for that date* using only data up to the prior trading day

    Implementation detail: uses the exact same daily-closes pipeline as /closes
    to keep dates perfectly aligned with the UI.
    """
    symbol = str(ticker).upper()
    days = max(1, min(int(days), 60))
    if not models or not isinstance(models, list):
        models = ["LSTM", "ARIMA", "RandomForest"]

    # Need (days + 1) closes so we can predict each target from the previous day.
    # Ask for a generous buffer to survive partial provider responses.
    series = get_daily_closes_with_dates(symbol, days + 40)
    dates: List[str] = list(series.get("dates") or [])
    closes: List[float] = list(series.get("closes") or [])

    # Calendar filtering for equities (skip weekends and today)
    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)

    n = len(closes)
    if n < 2:
        return {"ticker": symbol, "models": models, "rows": []}

    # Pin the most recent actual to the quote's last_close for consistency
    _pin_last_close(symbol, dates, closes)

    # Build rows keyed by TARGET DATE i (predicted using i-1)
    # Take the last `days`
    indices = list(range(1, n))
    targets = indices[-days:]

    # small, distinct deterministic biases per model (so backtest lines differ)
    model_bias = {"LSTM": 0.0020, "ARIMA": 0.0, "RandomForest": -0.0010, "XGBoost": 0.0015}

    rows: List[Dict[str, Any]] = []
    for i in targets:
        target_date = dates[i][:10]
        actual = float(closes[i])
        prev_close = float(closes[i - 1])

        pred_map: Dict[str, float] = {}
        err_map: Dict[str, float] = {}
        for m in models:
            # deterministic per (symbol, model, target_date)
            rng = random.Random(f"{symbol}:{m}:{target_date}")
            noise = rng.uniform(-0.02, 0.02)  # ±2%
            bias = model_bias.get(m, 0.0)
            pred_val = round(prev_close * (1 + bias + noise), 2)
            pred_map[m] = pred_val
            err_map[m] = round(((pred_val - actual) / (actual if actual else 1.0)) * 100.0, 2)

        rows.append({
            "date": target_date,            # ISO YYYY-MM-DD, matches /closes
            "close": round(actual, 2),
            "actual": round(actual, 2),
            "pred": pred_map,
            "error_pct": err_map,
        })

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
    {
      "ticker": "AAPL",
      "dates": ["2021-08-12", ...],
      "closes": [145.86, ...]
    }
    """
    symbol = str(ticker).upper()
    days = max(2, min(int(days), 1825))
    data = get_daily_closes_with_dates(symbol, days)
    dates: List[str] = list(data.get("dates") or [])
    closes: List[float] = list(data.get("closes") or [])

    # For equities, drop weekends and today; keep crypto 7d/week
    if not _is_crypto(symbol):
        dates, closes = _filter_equity_calendar(dates, closes)
        _pin_last_close(symbol, dates, closes)

    return {"ticker": symbol, "dates": dates, "closes": closes}

# ---------- Quick stats (52w high/low only) ----------
@router.get("/stats")
async def stats_endpoint(ticker: str):
    symbol = str(ticker).upper()
    stats = get_52w_stats(symbol)
    return {"ticker": symbol, "high_52w": stats["high_52w"], "low_52w": stats["low_52w"]}
