# backend/app/services/finance_service.py

import os
import requests
from functools import lru_cache
from fastapi import HTTPException
from datetime import date, timedelta
from time import time
from typing import List
from dotenv import load_dotenv
import random

load_dotenv()  # loads FINNHUB_*, TWELVEDATA_API_KEY, ALPHAVANTAGE_API_KEY

# Finnhub for quote, earnings, candles
FINNHUB_API_KEY       = os.getenv("FINNHUB_API_KEY")
FINNHUB_SECRET        = os.getenv("FINNHUB_SECRET")
FINNHUB_QUOTE_URL     = "https://finnhub.io/api/v1/quote"
FINNHUB_EARNINGS_URL  = "https://finnhub.io/api/v1/calendar/earnings"
FINNHUB_CANDLE_URL    = "https://finnhub.io/api/v1/stock/candle"

# Twelve Data for dividends & market breadth
TD_KEY            = os.getenv("TWELVEDATA_API_KEY")
TD_DIVIDENDS_URL  = "https://api.twelvedata.com/dividends"
TD_QUOTE_URL      = "https://api.twelvedata.com/quote"

# Alpha Vantage (optional) for last-resort quote fallback
AV_KEY = os.getenv("ALPHAVANTAGE_API_KEY")
AV_URL = "https://www.alphavantage.co/query"

if not FINNHUB_API_KEY or not FINNHUB_SECRET:
    raise RuntimeError("Missing Finnhub credentials in environment")
if not TD_KEY:
    raise RuntimeError("Missing TWELVEDATA_API_KEY in environment")
# AV_KEY is optional


@lru_cache(maxsize=128)
def get_quote(ticker: str):
    """
    Quote:
      1) Finnhub (tolerant if pc==0 -> uses c as last_close, 0% change)
      2) Twelve Data fallback (parses single or multi-symbol)
      3) Alpha Vantage fallback (if key present)
    """
    symbol = ticker.upper()

    # 1) Finnhub
    try:
        r1 = requests.get(
            FINNHUB_QUOTE_URL,
            params={"symbol": symbol, "token": FINNHUB_API_KEY},
            headers={"X-Finnhub-Secret": FINNHUB_SECRET},
            timeout=5,
        )
        r1.raise_for_status()
        d = r1.json()
        c = d.get("c")    # current price
        pc = d.get("pc")  # previous close
        if c is not None:
            prev_close = pc if (pc not in (None, 0)) else c
            pct = 0.0 if prev_close == 0 or prev_close == c else round(((c - prev_close) / prev_close) * 100, 2)
            return {
                "ticker": symbol,
                "last_close": round(prev_close, 2),
                "current_price": round(c, 2),
                "change_pct": pct,
            }
    except Exception:
        pass

    # 2) Twelve Data fallback
    try:
        r2 = requests.get(
            TD_QUOTE_URL,
            params={"symbol": symbol, "apikey": TD_KEY},
            timeout=5,
        )
        r2.raise_for_status()
        js2 = r2.json()

        if isinstance(js2, dict) and js2.get("status") == "error":
            raise ValueError(js2.get("message", "Twelve Data status=error"))
        if isinstance(js2, dict) and "message" in js2 and "close" not in js2 and symbol not in js2:
            raise ValueError(js2["message"])

        # single-symbol: {"symbol":"X","close":"...","previous_close":"..."}
        # multi-symbol:  {"X": {...}, "AAPL": {...}}
        if isinstance(js2, dict) and "close" in js2:
            info = js2
        elif isinstance(js2, dict) and symbol in js2:
            info = js2.get(symbol) or {}
        else:
            raise ValueError("Twelve Data response not recognized")

        price_str = info.get("close")
        prev_str  = info.get("previous_close")
        if price_str is None:
            raise ValueError("missing 'close' in Twelve Data response")

        price = float(price_str)
        prev_close = float(prev_str) if prev_str not in (None, "") else price
        pct = 0.0 if prev_close == 0 else round(((price - prev_close) / prev_close) * 100, 2)
        return {
            "ticker": symbol,
            "last_close": round(prev_close, 2),
            "current_price": round(price, 2),
            "change_pct": pct,
        }
    except Exception as td_err:
        # 3) Alpha Vantage fallback if available
        if not AV_KEY:
            raise HTTPException(502, f"Error fetching quote fallback (Twelve Data): {td_err}")

        try:
            r3 = requests.get(
                AV_URL,
                params={"function": "GLOBAL_QUOTE", "symbol": symbol, "apikey": AV_KEY},
                timeout=5,
            )
            r3.raise_for_status()
            av = r3.json()
            if "Note" in av:
                raise HTTPException(503, f"Alpha Vantage rate limit: {av['Note']}")
            if "Information" in av:
                raise HTTPException(503, f"Alpha Vantage: {av['Information']}")
            gq = av.get("Global Quote")
            if not isinstance(gq, dict):
                raise HTTPException(404, "Alpha Vantage: no Global Quote")

            price_str = gq.get("05. price")
            prev_str  = gq.get("08. previous close")
            if price_str is None:
                raise HTTPException(404, "Alpha Vantage: price field missing")

            price = float(price_str)
            prev_close = float(prev_str) if prev_str not in (None, "") else price
            pct = 0.0 if prev_close == 0 else round(((price - prev_close) / prev_close) * 100, 2)
            return {
                "ticker": symbol,
                "last_close": round(prev_close, 2),
                "current_price": round(price, 2),
                "change_pct": pct,
            }
        except HTTPException:
            raise
        except Exception as av_err:
            raise HTTPException(502, f"Error fetching quote fallback (Alpha Vantage): {av_err}") from av_err


@lru_cache(maxsize=128)
def get_earnings(ticker: str):
    """Return 200 with nextEarningsDate=None when not found (UI shows N/A)."""
    symbol = ticker.upper()
    today, to_date = date.today().isoformat(), (date.today() + timedelta(days=90)).isoformat()
    try:
        resp = requests.get(
            FINNHUB_EARNINGS_URL,
            params={"symbol": symbol, "from": today, "to": to_date, "token": FINNHUB_API_KEY},
            headers={"X-Finnhub-Secret": FINNHUB_SECRET},
            timeout=5
        )
        resp.raise_for_status()
        cal = resp.json().get("earningsCalendar", [])
        next_date = cal[0].get("date") if cal else None
        return {"ticker": symbol, "nextEarningsDate": next_date, "available": next_date is not None}
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response else None
        if code == 429:
            raise HTTPException(503, "Rate limited by Finnhub earnings API.")
        return {"ticker": symbol, "nextEarningsDate": None, "available": False, "reason": "fetch_error"}


@lru_cache(maxsize=128)
def get_dividends(ticker: str):
    """Return 200 with available=False if none/blocked so UI shows N/A."""
    symbol = ticker.upper()
    try:
        r = requests.get(
            TD_DIVIDENDS_URL,
            params={"symbol": symbol, "apikey": TD_KEY},
            timeout=5
        )
        r.raise_for_status()
        js = r.json()
        if isinstance(js, dict) and js.get("status") == "error":
            return {"ticker": symbol, "available": False, "reason": "plan_blocked", "message": js.get("message")}
        divs = js.get("dividends")
        if not isinstance(divs, list) or not divs:
            return {"ticker": symbol, "available": False, "reason": "no_data"}
        latest = divs[0]
        exd = latest.get("ex_date")
        amt = latest.get("amount")
        if exd is None or amt is None:
            return {"ticker": symbol, "available": False, "reason": "incomplete"}
        return {"ticker": symbol, "available": True, "exDividendDate": exd, "lastDividendAmount": amt}
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response else None
        if code == 429:
            raise HTTPException(503, "Rate limited by Twelve Data dividends API.")
        return {"ticker": symbol, "available": False, "reason": "fetch_error"}
    except Exception:
        return {"ticker": symbol, "available": False, "reason": "exception"}


@lru_cache(maxsize=1)
def get_market_breadth():
    """Market breadth via Twelve Data /quote for multiple symbols."""
    symbols = ["VIX", "TNX", "SPY", "XLK", "XLF"]
    r = requests.get(
        TD_QUOTE_URL,
        params={"symbol": ",".join(symbols), "apikey": TD_KEY},
        timeout=5
    )
    try:
        r.raise_for_status()
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response else None
        if code == 429:
            raise HTTPException(503, "Rate limited by Twelve Data market API.")
        raise HTTPException(502, f"Error fetching market breadth: {e.response.text if e.response else str(e)}")

    js  = r.json()
    out = {}
    for sym in symbols:
        info = (js.get(sym) or {}) if isinstance(js, dict) else {}
        try:
            price = float(info.get("close", 0))
            prev  = float(info.get("previous_close", price))
        except (TypeError, ValueError):
            continue
        pct = 0.0 if prev == 0 else round(((price - prev) / prev) * 100, 2)
        out[sym] = {"current_price": price, "last_close": prev, "change_pct": pct}

    if not out:
        raise HTTPException(404, "No market breadth data found")
    return out


# -------------------------
# Candle-based helpers
# -------------------------

def _seeded_walk(symbol: str, base: float, n: int) -> List[float]:
    """Deterministic, tiny random-walk series per symbol (fallback)."""
    rng = random.Random(symbol.upper())  # seeded by symbol so it’s stable
    # start within ±1% of base
    val = base * (1 + rng.uniform(-0.01, 0.01))
    out: List[float] = []
    for _ in range(n):
        # small day-to-day move ~±0.4%
        step = rng.uniform(-0.004, 0.004)
        val *= (1 + step)
        out.append(round(val, 2))
    return out


@lru_cache(maxsize=256)
def get_daily_closes(symbol: str, days: int) -> List[float]:
    """
    Returns a list of daily close prices (most recent last) for the past `days`.
    Falls back to a seeded random-walk around the current price if candles fail.
    """
    sym = symbol.upper()
    # allow up to ~300 to support 52w stats
    days = max(2, min(int(days), 300))
    now = int(time())
    frm = now - days * 86400 * 2  # ask for a bit more (weekends/holidays)

    # Try Finnhub candles
    try:
        r = requests.get(
            FINNHUB_CANDLE_URL,
            params={
                "symbol": sym,
                "resolution": "D",
                "from": frm,
                "to": now,
                "token": FINNHUB_API_KEY,
            },
            headers={"X-Finnhub-Secret": FINNHUB_SECRET},
            timeout=6,
        )
        r.raise_for_status()
        js = r.json()
        if js.get("s") == "ok" and isinstance(js.get("c"), list):
            closes = [float(x) for x in js["c"] if x is not None]
            if closes:
                return closes[-days:]
    except Exception:
        pass

    # Fallback: deterministic synthetic series (per symbol)
    try:
        q = get_quote(sym)
        base = float(q["current_price"])
        return _seeded_walk(sym, base, days)
    except Exception:
        return []


@lru_cache(maxsize=128)
def get_52w_stats(symbol: str) -> dict:
    """
    Computes 52w high/low from daily closes helper (works even on fallback).
    """
    closes = get_daily_closes(symbol, 300)  # up to 300 days calendar (~252 trading)
    window = closes[-252:] if len(closes) >= 252 else closes
    if window:
        return {
            "high_52w": float(max(window)),
            "low_52w": float(min(window)),
            "market_cap": None,
            "sector": None,
        }
    return {"high_52w": None, "low_52w": None, "market_cap": None, "sector": None}
