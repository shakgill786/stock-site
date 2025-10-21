# app/sentiment_routes.py
from __future__ import annotations

import asyncio
import os
from datetime import date, timedelta, datetime
from typing import Any, Dict, List, Optional, Tuple
import math
import json

import httpx
from fastapi import APIRouter, Query
from starlette.responses import StreamingResponse
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from app.services.finance_service import (
    get_daily_closes_with_dates,
    get_daily_closes,
)

router = APIRouter(prefix="/sentiment", tags=["Sentiment"])

FINNHUB_KEY = os.getenv("FINNHUB_API_KEY", "")
VADER = SentimentIntensityAnalyzer()

def _iso(d: date) -> str:
    return d.isoformat()

def _today() -> date:
    return date.today()

async def _fetch_news_finnhub(ticker: str, start: date, end: date) -> List[Dict[str, Any]]:
    """
    Finnhub company news for a date window.
    NOTE: This stays within free tier rules (date-bounded).
    """
    if not FINNHUB_KEY:
        return []
    url = "https://finnhub.io/api/v1/company-news"
    params = {"symbol": ticker.upper(), "from": _iso(start), "to": _iso(end), "token": FINNHUB_KEY}
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.get(url, params=params)
        if r.status_code != 200:
            return []
        data = r.json() or []
    out = []
    for n in data:
        # Normalize basic fields we need
        ts = n.get("datetime") or n.get("time")
        if isinstance(ts, (int, float)):
            dt = datetime.utcfromtimestamp(ts)
        else:
            dt = datetime.utcnow()
        out.append({
            "datetime": dt.isoformat() + "Z",
            "date": dt.date().isoformat(),
            "source": n.get("source") or "finnhub",
            "headline": n.get("headline") or n.get("title") or "",
            "summary": n.get("summary") or "",
            "url": n.get("url") or "",
        })
    return out

def _score_text(text: str) -> Dict[str, float]:
    s = VADER.polarity_scores(text or "")
    # keep compound only; others are available if needed
    return {"compound": float(s.get("compound", 0.0))}

def _label(compound: float) -> str:
    if compound >= 0.25:
        return "pos"
    if compound <= -0.25:
        return "neg"
    return "neu"

def _agg_daily(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    buckets: Dict[str, List[float]] = {}
    for x in items:
        d = str(x.get("date") or x.get("datetime", "")[:10] or "")
        c = float(x.get("sentiment", {}).get("compound", 0.0))
        if d:
            buckets.setdefault(d, []).append(c)
    out = []
    for d, vals in buckets.items():
        if not vals:
            continue
        n = len(vals)
        mean = sum(vals) / n
        var = sum((v - mean) ** 2 for v in vals) / n
        out.append({
            "date": d,
            "count": n,
            "mean_compound": round(mean, 6),
            "std_compound": round(math.sqrt(var), 6),
        })
    out.sort(key=lambda r: r["date"])
    return out

async def _closes_for(ticker: str, days: int = 120) -> Tuple[List[str], List[float]]:
    try:
        data = await asyncio.to_thread(get_daily_closes_with_dates, ticker.upper(), days)
        dates = list(data.get("dates") or [])
        closes = list(data.get("closes") or [])
        return dates, closes
    except Exception:
        return [], []

# ------------- Endpoints -------------

@router.get("/news", summary="Latest news + sentiment for ticker")
async def news_endpoint(ticker: str, window_days: int = 7, limit: int = 100):
    window_days = max(1, min(window_days, 30))
    end = _today()
    start = end - timedelta(days=window_days)
    raw = await _fetch_news_finnhub(ticker, start, end)

    items: List[Dict[str, Any]] = []
    for n in raw[:limit]:
        text = f"{n.get('headline', '')} {n.get('summary', '')}".strip()
        sentiment = _score_text(text)
        items.append({
            **n,
            "sentiment": {**sentiment, "label": _label(sentiment["compound"])},
        })
    return {"ticker": ticker.upper(), "window_days": window_days, "items": items}

@router.get("/daily", summary="Daily aggregated sentiment for ticker")
async def daily_endpoint(ticker: str, window_days: int = 60):
    window_days = max(1, min(window_days, 365))
    end = _today()
    start = end - timedelta(days=window_days)
    raw = await _fetch_news_finnhub(ticker, start, end)
    items = []
    for n in raw:
        text = (n.get("headline", "") + " " + n.get("summary", "")).strip()
        s = _score_text(text)
        items.append({**n, "sentiment": s})
    daily = _agg_daily(items)
    return {"ticker": ticker.upper(), "rows": daily}

@router.get("/correlate", summary="Correlation between daily sentiment and price returns")
async def correlate_endpoint(ticker: str, days: int = 120):
    days = max(10, min(days, 365))
    # get aggregated daily sentiment
    end = _today()
    start = end - timedelta(days=days)
    raw = await _fetch_news_finnhub(ticker, start, end)
    scored = [{**n, "sentiment": _score_text((n.get("headline","")+" "+n.get("summary","")).strip())} for n in raw]
    daily = _agg_daily(scored)  # [{date, mean_compound, count, std_compound}]

    # get closes
    dates, closes = await _closes_for(ticker, days + 10)
    d2c = {str(d)[:10]: float(c) for d, c in zip(dates, closes) if c is not None}

    # build aligned time series
    rows = []
    sorted_days = sorted(d2c.keys())
    for i, d in enumerate(sorted_days):
        close = d2c[d]
        prev = d2c.get(sorted_days[i-1]) if i > 0 else None
        next_ = d2c.get(sorted_days[i+1]) if i + 1 < len(sorted_days) else None
        if prev is None:
            continue
        same_day_ret = (close - prev) / prev * 100.0 if prev else 0.0
        next_day_ret = ((next_ - close) / close * 100.0) if (next_ and close) else None

        sent = next((r["mean_compound"] for r in daily if r["date"] == d), 0.0)
        rows.append({
            "date": d,
            "sentiment": sent,
            "return_pct": round(same_day_ret, 6),
            "next_day_return_pct": round(next_day_ret, 6) if next_day_ret is not None else None,
        })

    # compute simple Pearson correlations over valid points
    def _pearson(xs: List[float], ys: List[float]) -> Optional[float]:
        if len(xs) != len(ys) or len(xs) < 3:
            return None
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        denx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        deny = math.sqrt(sum((y - my) ** 2 for y in ys))
        if denx == 0 or deny == 0:
            return None
        return num / (denx * deny)

    same = [r for r in rows if isinstance(r["return_pct"], (int, float))]
    nextd = [r for r in rows if isinstance(r["next_day_return_pct"], (int, float))]

    corr_same = _pearson([r["sentiment"] for r in same], [r["return_pct"] for r in same])
    corr_next = _pearson([r["sentiment"] for r in nextd], [r["next_day_return_pct"] for r in nextd])

    return {
        "ticker": ticker.upper(),
        "rows": rows,
        "corr": {"same_day": corr_same, "next_day": corr_next},
    }

@router.get("/alerts_stream", summary="SSE: push alerts when sentiment crosses thresholds")
async def alerts_stream(
    tickers: str,
    neg_thresh: float = Query(-0.5, description="Trigger if mean_compound <= neg_thresh"),
    pos_thresh: float = Query(0.6, description="Trigger if mean_compound >= pos_thresh"),
    interval: float = Query(45.0, description="Polling seconds (min 10)"),
):
    interval = max(10.0, min(float(interval), 300.0))
    symbols = [t.strip().upper() for t in (tickers or "").split(",") if t.strip()]
    if not symbols:
        symbols = ["AAPL"]

    async def gen():
        while True:
            try:
                end = _today()
                start = end - timedelta(days=1)
                for sym in symbols:
                    raw = await _fetch_news_finnhub(sym, start, end)
                    if not raw:
                        continue
                    scored = [{**n, "sentiment": _score_text((n.get("headline","")+" "+n.get("summary","")).strip())} for n in raw]
                    daily = _agg_daily(scored)
                    if not daily:
                        continue
                    today_row = daily[-1]
                    score = float(today_row["mean_compound"])
                    alert = None
                    if score <= float(neg_thresh):
                        alert = {"type": "negative", "score": score}
                    elif score >= float(pos_thresh):
                        alert = {"type": "positive", "score": score}
                    if alert:
                        payload = {
                            "ticker": sym,
                            "date": today_row["date"],
                            "mean_compound": score,
                            "count": today_row["count"],
                            "alert": alert,
                            "ts": int(datetime.utcnow().timestamp()),
                        }
                        yield f"data: {json.dumps(payload)}\n\n"
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break
            except Exception:
                # swallow and continue
                await asyncio.sleep(interval)
    return StreamingResponse(gen(), media_type="text/event-stream")
