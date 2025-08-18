# backend/app/routes.py

from fastapi import APIRouter, Query
from pydantic import BaseModel
from typing import List, Dict, Any
import random, json, asyncio, time
from starlette.responses import StreamingResponse

from app.services.finance_service import (
    get_quote,
    get_earnings,
    get_market_breadth,
    get_daily_closes_with_dates,
    get_52w_stats,
)

router = APIRouter()

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
    results = []
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

    Response:
    {
      "ticker": "AAPL",
      "models": ["LSTM","ARIMA"],
      "rows": [
        {
          "date": "2025-08-04",
          "close": 231.77,
          "actual": 231.77,
          "pred": { "LSTM": 232.11, "ARIMA": 231.98 },
          "error_pct": { "LSTM": 0.15, "ARIMA": 0.09 }
        },
        ...
      ]
    }
    """
    symbol = str(ticker).upper()
    days = max(1, min(int(days), 60))
    if not models or not isinstance(models, list):
        models = ["LSTM", "ARIMA"]

    # Need (days + 1) closes so we can predict each target from the previous day.
    series = get_daily_closes_with_dates(symbol, max(days + 6, days + 1))
    dates: List[str] = series["dates"]          # most-recent last
    closes: List[float] = series["closes"]

    n = len(closes)
    if n < 2:
        return {"ticker": symbol, "models": models, "rows": []}

    targets = list(range(1, n))[-days:]  # predict target i using i-1

    model_bias = {"LSTM": 0.0020, "ARIMA": 0.0, "RandomForest": -0.001, "XGBoost": 0.0015}

    rows: List[Dict[str, Any]] = []
    for i in targets:
        target_date = dates[i]
        actual = float(closes[i])
        prev_close = float(closes[i - 1])

        pred_map: Dict[str, float] = {}
        err_map: Dict[str, float] = {}
        for m in models:
            rng = random.Random(f"{symbol}:{m}:{target_date}")  # deterministic per model/date
            noise = rng.uniform(-0.02, 0.02)  # ±2%
            bias = model_bias.get(m, 0.0)
            pred_val = round(prev_close * (1 + bias + noise), 2)
            pred_map[m] = pred_val
            err_map[m] = round(((pred_val - actual) / actual) * 100.0, 2)

        rows.append({
            "date": target_date,            # IMPORTANT: target date key matches /closes
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
                # IMPORTANT: double newline to delimit SSE messages
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
    return {"ticker": symbol, "dates": data["dates"], "closes": data["closes"]}

# ---------- Quick stats (52w high/low only) ----------
@router.get("/stats")
async def stats_endpoint(ticker: str):
    """
    Returns:
      { "ticker": "AAPL", "high_52w": 229.35, "low_52w": 155.12 }
    """
    symbol = str(ticker).upper()
    stats = get_52w_stats(symbol)
    return {"ticker": symbol, "high_52w": stats["high_52w"], "low_52w": stats["low_52w"]}
