# backend/app/services/finance_service.py

import os
import requests
from functools import lru_cache
from fastapi import HTTPException
from datetime import date, timedelta
from dotenv import load_dotenv

# Load your Finnhub API key from backend/.env
load_dotenv()
API_KEY = os.getenv("FINNHUB_API_KEY")
if not API_KEY:
    raise RuntimeError("Missing FINNHUB_API_KEY in environment")

# URLs for Finnhub
FINNHUB_QUOTE_URL    = "https://finnhub.io/api/v1/quote"
FINNHUB_EARNINGS_URL = "https://finnhub.io/api/v1/calendar/earnings"


@lru_cache(maxsize=128)
def get_quote(ticker: str):
    """Fetch current price & previous close from Finnhub."""
    params = {"symbol": ticker.upper(), "token": API_KEY}
    try:
        resp = requests.get(FINNHUB_QUOTE_URL, params=params, timeout=5)
        resp.raise_for_status()
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response else None
        if code == 429:
            raise HTTPException(503, "Rate limited by Finnhub. Try again shortly.")
        raise HTTPException(502, f"Error fetching Finnhub quote: {e.response.text}")

    data = resp.json()
    c  = data.get("c")   # current price
    pc = data.get("pc")  # previous close
    if c is None or pc is None:
        raise HTTPException(404, "Finnhub did not return current price or previous close")

    change     = c - pc
    pct_change = round((change / pc) * 100, 2)
    return {
        "ticker": ticker.upper(),
        "last_close": round(pc, 2),
        "current_price": round(c, 2),
        "change_pct": pct_change,
    }


@lru_cache(maxsize=128)
def get_earnings(ticker: str):
    """Fetch next earnings date (within 90 days) from Finnhub."""
    today   = date.today().isoformat()
    to_date = (date.today() + timedelta(days=90)).isoformat()
    params  = {
        "from": today,
        "to": to_date,
        "symbol": ticker.upper(),
        "token": API_KEY
    }
    try:
        resp = requests.get(FINNHUB_EARNINGS_URL, params=params, timeout=5)
        resp.raise_for_status()
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response else None
        if code == 429:
            raise HTTPException(503, "Rate limited by Finnhub earnings API.")
        raise HTTPException(502, f"Error fetching earnings: {e.response.text}")

    earnings_list = resp.json().get("earningsCalendar", [])
    if not earnings_list:
        raise HTTPException(404, "No upcoming earnings found")
    next_date = earnings_list[0].get("date")
    return {"ticker": ticker.upper(), "nextEarningsDate": next_date}
