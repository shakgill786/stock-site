# backend/app/routes.py

from fastapi import APIRouter
from pydantic import BaseModel
from typing import List
import random, json, asyncio, time
from starlette.responses import StreamingResponse

from app.services.finance_service import (
    get_quote,
    get_earnings,
    get_market_breadth,
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

# ---------- Closes for sparklines ----------
@router.get("/closes")
async def closes_endpoint(ticker: str, days: int = 7):
    from app.services.tech_service import _fetch_series_first, _base_variants
    days = max(2, min(int(days), 60))
    series = _fetch_series_first(_base_variants(ticker), max(days, 10))
    if not series:
        return {"ticker": str(ticker).upper(), "closes": []}
    return {"ticker": str(ticker).upper(), "closes": series[-days:]}

# ---------- Quick stats (52w high/low; cap/sector placeholders) ----------
@router.get("/stats")
async def stats_endpoint(ticker: str):
    """
    Returns:
      {
        "ticker": "AAPL",
        "high_52w": 229.35,
        "low_52w": 155.12,
        "market_cap": null,
        "sector": null
      }
    """
    from app.services.tech_service import _fetch_series_first, _base_variants
    # ~52 trading weeks ≈ 252 trading days; grab a bit extra
    series = _fetch_series_first(_base_variants(ticker), 270)
    if not series:
        return {
            "ticker": str(ticker).upper(),
            "high_52w": None,
            "low_52w": None,
            "market_cap": None,
            "sector": None,
        }
    return {
        "ticker": str(ticker).upper(),
        "high_52w": float(max(series[-252:] if len(series) >= 252 else series)),
        "low_52w": float(min(series[-252:] if len(series) >= 252 else series)),
        "market_cap": None,  # TODO: wire to a profile endpoint if you like
        "sector": None,      # TODO: wire to a profile endpoint if you like
    }
