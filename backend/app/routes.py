# backend/app/routes.py

from fastapi import APIRouter
from fastapi import HTTPException
from pydantic import BaseModel
from typing import List
import random

from app.services.finance_service import get_quote, get_earnings

router = APIRouter()


@router.get("/hello")
async def say_hello():
    return {"message": "Hello from FastAPI!"}


# --- Predict endpoint & schemas ---

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
    # Use the live quote as a base so stubs are realistic
    quote = get_quote(req.ticker)
    base_price = quote["current_price"]

    results = []
    for m in req.models:
        # generate 7 days of +/-5% around base_price
        preds = [
            round(base_price * (1 + random.uniform(-0.05, 0.05)), 2)
            for _ in range(7)
        ]
        # confidence between 70% and 100%
        confs = [round(random.uniform(0.7, 1.0), 2) for _ in range(7)]
        results.append(ModelPrediction(
            model=m,
            predictions=preds,
            confidence=confs
        ))

    return PredictResponse(results=results)


# --- Quote endpoint for current price ---

@router.get("/quote")
async def quote_endpoint(ticker: str):
    return get_quote(ticker)


# --- Earnings endpoint for next earnings date ---

@router.get("/earnings")
async def earnings_endpoint(ticker: str):
    return get_earnings(ticker)
