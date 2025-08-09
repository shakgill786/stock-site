# backend/app/routes.py

from fastapi import APIRouter
from pydantic import BaseModel
from typing import List
import random

from app.services.finance_service import (
    get_quote,
    get_earnings,
    get_dividends,
    get_market_breadth
)

router = APIRouter()


@router.get("/hello")
async def say_hello():
    return {"message": "Hello from FastAPI!"}


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


@router.get("/quote")
async def quote_endpoint(ticker: str):
    return get_quote(ticker)


@router.get("/earnings")
async def earnings_endpoint(ticker: str):
    return get_earnings(ticker)


@router.get("/dividends")
async def dividends_endpoint(ticker: str):
    return get_dividends(ticker)


@router.get("/market")
async def market_endpoint():
    return get_market_breadth()
