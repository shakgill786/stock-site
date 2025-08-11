from fastapi import APIRouter
from pydantic import BaseModel
from typing import List
import random, json, asyncio, time

from app.services.finance_service import (
    get_quote,
    get_earnings,
    get_market_breadth,
)
from starlette.responses import StreamingResponse

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
    """
    Server-Sent Events stream of quotes.
    usage (browser): new EventSource(`/quote_stream?ticker=AAPL&interval=5`)
    """
    interval = max(1.0, min(float(interval), 60.0))

    async def event_gen():
        try:
            while True:
                q = get_quote(ticker)  # reuse your existing provider
                payload = {
                    "ticker": q.get("ticker", ticker.upper()),
                    "current_price": q.get("current_price"),
                    "last_close": q.get("last_close"),
                    "change_pct": q.get("change_pct"),
                    "ts": int(time.time()),
                }
                yield f"data: {json.dumps(payload)}\n\n"
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            # client disconnected
            return

    return StreamingResponse(event_gen(), media_type="text/event-stream")
