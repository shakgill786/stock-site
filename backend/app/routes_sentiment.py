# app/routes_sentiment.py
from __future__ import annotations
from fastapi import APIRouter, Query
from typing import List, Dict, Any, Optional
import asyncio

from app.services.news_service import (
    fetch_news_headlines, score_headlines, aggregate_daily_sentiment,
    correlate_with_returns, topic_model
)
from app.services.finance_service import get_daily_closes_with_dates

router = APIRouter(prefix="/sentiment", tags=["Sentiment"])

@router.get("/news")
async def news(ticker: str, limit: int = 80):
    items = await fetch_news_headlines(ticker, limit=limit)
    scored = await score_headlines(items)
    return {"ticker": ticker.upper(), "items": scored}

@router.get("/daily")
async def daily(ticker: str, limit: int = 120):
    items = await fetch_news_headlines(ticker, limit=limit)
    scored = await score_headlines(items)
    daily = aggregate_daily_sentiment(scored)
    return {"ticker": ticker.upper(), "daily": daily}

@router.get("/correlate")
async def correlate(ticker: str, days: int = 120):
    t = ticker.upper()
    # parallel: headlines + closes
    items_task = asyncio.create_task(fetch_news_headlines(t, limit=200))
    closes_task = asyncio.create_task(asyncio.to_thread(get_daily_closes_with_dates, t, days))
    items = await items_task
    scored = await score_headlines(items)
    daily = aggregate_daily_sentiment(scored)
    series = await closes_task
    dates = list(series.get("dates") or [])
    closes = [float(x) for x in list(series.get("closes") or [])]
    res = correlate_with_returns(dates, closes, daily)
    return {
        "ticker": t,
        "daily": daily,         # [{date, mean, count}]
        "closes_dates": dates,  # passthrough for overlay charts
        "closes": closes,
        "correlation": res,     # {n, pearson_r, pairs:[{date,sent,ret}]}
    }

@router.get("/matrix")
async def matrix(tickers: List[str] = Query(...), days: int = 90):
    # Build a sentiment-vs-return correlation for each ticker, return list
    out = []
    for raw in tickers:
        t = (raw or "").upper().strip()
        if not t:
            continue
        try:
            items = await fetch_news_headlines(t, limit=160)
            scored = await score_headlines(items)
            daily = aggregate_daily_sentiment(scored)
            series = await asyncio.to_thread(get_daily_closes_with_dates, t, days)
            dates = list(series.get("dates") or [])
            closes = [float(x) for x in list(series.get("closes") or [])]
            corr = correlate_with_returns(dates, closes, daily)
            out.append({"ticker": t, "n": corr.get("n", 0), "pearson_r": corr.get("pearson_r", float("nan"))})
        except Exception:
            out.append({"ticker": t, "n": 0, "pearson_r": float("nan")})
    return {"rows": out}

@router.get("/topics")
async def topics(ticker: str, k: int = 5, limit: int = 120):
    items = await fetch_news_headlines(ticker, limit=limit)
    scored = await score_headlines(items)
    tm = topic_model(scored, k=k)
    return {"ticker": ticker.upper(), "topics": tm, "count": len(scored)}
