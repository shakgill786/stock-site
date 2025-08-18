# backend/app/services/finance_service.py

import os
import requests
from fastapi import HTTPException
from datetime import date, datetime, timedelta
from time import time
from typing import List, Tuple, Dict, Optional

from functools import lru_cache
from dotenv import load_dotenv
import random

# Optional: yfinance for accurate historical closes
try:
    import yfinance as yf  # type: ignore
except Exception:  # pragma: no cover
    yf = None

load_dotenv()  # loads FINNHUB_*, TWELVEDATA_API_KEY, ALPHAVANTAGE_API_KEY

# Finnhub for quote, earnings, candles
FINNHUB_API_KEY       = os.getenv("FINNHUB_API_KEY")
FINNHUB_SECRET        = os.getenv("FINNHUB_SECRET")
FINNHUB_QUOTE_URL     = "https://finnhub.io/api/v1/quote"
FINNHUB_EARNINGS_URL  = "https://finnhub.io/api/v1/calendar/earnings"
FINNHUB_CANDLE_URL    = "https://finnhub.io/api/v1/stock/candle"

# Twelve Data
TD_KEY               = os.getenv("TWELVEDATA_API_KEY")
TD_DIVIDENDS_URL     = "https://api.twelvedata.com/dividends"
TD_QUOTE_URL         = "https://api.twelvedata.com/quote"
TD_TIME_SERIES_URL   = "https://api.twelvedata.com/time_series"

# Alpha Vantage (optional) for last-resort quote fallback
AV_KEY = os.getenv("ALPHAVANTAGE_API_KEY")
AV_URL = "https://www.alphavantage.co/query"

if not FINNHUB_API_KEY or not FINNHUB_SECRET:
    raise RuntimeError("Missing Finnhub credentials in environment")
if not TD_KEY:
    raise RuntimeError("Missing TWELVEDATA_API_KEY in environment")
# AV_KEY is optional

# -------------------------
# Utils
# -------------------------

def _is_crypto(symbol: str) -> bool:
    return "-" in (symbol or "")

def _drop_today_for_equities(dates: List[str], closes: List[float]) -> Tuple[List[str], List[float]]:
    if not dates or not closes or len(dates) != len(closes):
        return dates or [], closes or []
    today_iso = date.today().isoformat()
    out_d, out_c = [], []
    for d, c in zip(dates, closes):
        dd = str(d)[:10]
        if dd == today_iso:
            continue
        out_d.append(dd)
        out_c.append(float(c))
    return out_d, out_c

# -------------------------
# Quote / Earnings / Market
# -------------------------

@lru_cache(maxsize=128)
def get_quote(ticker: str):
    """
    Quote:
      1) Finnhub
      2) Twelve Data
      3) Alpha Vantage
      4) FINAL FALLBACK: use latest daily close so downstream endpoints never break
    """
    symbol = ticker.upper()

    # 1) Finnhub
    try:
        r1 = requests.get(
            FINNHUB_QUOTE_URL,
            params={"symbol": symbol, "token": FINNHUB_API_KEY},
            headers={"X-Finnhub-Secret": FINNHUB_SECRET},
            timeout=6,
        )
        r1.raise_for_status()
        d = r1.json()
        c = d.get("c")
        pc = d.get("pc")
        if c is not None:
            prev_close = pc if (pc not in (None, 0)) else c
            pct = 0.0 if prev_close == 0 or prev_close == c else round(((c - prev_close) / prev_close) * 100, 2)
            return {"ticker": symbol, "last_close": round(prev_close, 2), "current_price": round(c, 2), "change_pct": pct}
    except Exception:
        pass

    # 2) Twelve Data
    try:
        r2 = requests.get(TD_QUOTE_URL, params={"symbol": symbol, "apikey": TD_KEY}, timeout=6)
        r2.raise_for_status()
        js2 = r2.json()
        if isinstance(js2, dict) and js2.get("status") == "error":
            raise ValueError(js2.get("message", "TD status=error"))
        if isinstance(js2, dict) and "close" in js2:
            price = float(js2["close"])
            prev  = float(js2.get("previous_close", price))
        elif isinstance(js2, dict) and symbol in js2:
            info = js2[symbol]
            price = float(info.get("close"))
            prev  = float(info.get("previous_close", price))
        else:
            raise ValueError("TD quote response not recognized")
        pct = 0.0 if prev == 0 else round(((price - prev) / prev) * 100, 2)
        return {"ticker": symbol, "last_close": round(prev, 2), "current_price": round(price, 2), "change_pct": pct}
    except Exception:
        pass

    # 3) Alpha Vantage
    if AV_KEY:
        try:
            r3 = requests.get(AV_URL, params={"function": "GLOBAL_QUOTE", "symbol": symbol, "apikey": AV_KEY}, timeout=8)
            r3.raise_for_status()
            av = r3.json()
            gq = av.get("Global Quote")
            if isinstance(gq, dict):
                price = float(gq.get("05. price"))
                prev  = float(gq.get("08. previous close", price))
                pct = 0.0 if prev == 0 else round(((price - prev) / prev) * 100, 2)
                return {"ticker": symbol, "last_close": round(prev, 2), "current_price": round(price, 2), "change_pct": pct}
        except Exception:
            pass

    # 4) Final fallback: derive from latest closes so /predict never dies
    try:
        closes = get_daily_closes(symbol, 2)
        last = closes[-1] if closes else None
        if last is not None:
            last_f = float(last)
            return {"ticker": symbol, "last_close": round(last_f, 2), "current_price": round(last_f, 2), "change_pct": 0.0}
    except Exception:
        pass

    # If absolutely nothing worked
    raise HTTPException(502, f"Could not fetch quote for {symbol}")

@lru_cache(maxsize=128)
def get_earnings(ticker: str):
    symbol = ticker.upper()
    today, to_date = date.today().isoformat(), (date.today() + timedelta(days=90)).isoformat()
    try:
        resp = requests.get(
            FINNHUB_EARNINGS_URL,
            params={"symbol": symbol, "from": today, "to": to_date, "token": FINNHUB_API_KEY},
            headers={"X-Finnhub-Secret": FINNHUB_SECRET},
            timeout=6
        )
        resp.raise_for_status()
        cal = resp.json().get("earningsCalendar", [])
        next_date = cal[0].get("date") if cal else None
        return {"ticker": symbol, "nextEarningsDate": next_date, "available": next_date is not None}
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 429:
            raise HTTPException(503, "Rate limited by Finnhub earnings API.")
        return {"ticker": symbol, "nextEarningsDate": None, "available": False, "reason": "fetch_error"}

@lru_cache(maxsize=128)
def get_dividends(ticker: str):
    symbol = ticker.upper()
    try:
        r = requests.get(TD_DIVIDENDS_URL, params={"symbol": symbol, "apikey": TD_KEY}, timeout=6)
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
        if e.response is not None and e.response.status_code == 429:
            raise HTTPException(503, "Rate limited by Twelve Data dividends API.")
        return {"ticker": symbol, "available": False, "reason": "fetch_error"}
    except Exception:
        return {"ticker": symbol, "available": False, "reason": "exception"}

@lru_cache(maxsize=1)
def get_market_breadth():
    symbols = ["VIX", "TNX", "SPY", "XLK", "XLF"]
    try:
        r = requests.get(TD_QUOTE_URL, params={"symbol": ",".join(symbols), "apikey": TD_KEY}, timeout=6)
        r.raise_for_status()
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 429:
            raise HTTPException(503, "Rate limited by Twelve Data market API.")
        raise HTTPException(502, f"Error fetching market breadth: {e.response.text if e.response else str(e)}")

    js = r.json()
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
# Historical closes helpers
# -------------------------

def _yf_download(symbol: str, days: int) -> Optional[Dict[str, List]]:
    if yf is None:
        return None
    period_days = max(int(days) + 15, 25)
    try:
        df = yf.download(
            symbol,
            period=f"{period_days}d",
            interval="1d",
            auto_adjust=False,  # we want unadjusted Close to match Yahoo "Close"
            progress=False,
            threads=False,
        )
        if df is None or df.empty or "Close" not in df.columns:
            return None
        df = df.dropna(subset=["Close"])
        closes = [float(v) for v in df["Close"].tolist()]
        dates: List[str] = []
        for ts in df.index:
            try:
                try:
                    ts = ts.tz_localize(None)
                except Exception:
                    pass
                dates.append(ts.date().isoformat())
            except Exception:
                dates.append(str(ts)[:10])
        return {"dates": dates[-days:], "closes": closes[-days:]}
    except Exception:
        return None

def _twelve_download(symbol: str, days: int) -> Optional[Dict[str, List]]:
    """Twelve Data daily time series -> unadjusted Close."""
    try:
        outsize = max(int(days) + 15, 40)
        r = requests.get(
            TD_TIME_SERIES_URL,
            params={
                "symbol": symbol,
                "interval": "1day",
                "outputsize": outsize,
                "order": "ASC",
                "apikey": TD_KEY,
            },
            timeout=8,
        )
        r.raise_for_status()
        js = r.json()
        if isinstance(js, dict) and js.get("status") == "error":
            return None
        # format: { "values": [ { "datetime": "2025-08-15", "close": "231.59", ...}, ...] }
        values = js.get("values")
        if not isinstance(values, list) or not values:
            return None
        ds: List[str] = []
        cs: List[float] = []
        for row in values:
            dt = str(row.get("datetime") or row.get("date") or "")[:10]
            cl = row.get("close")
            if not dt or cl is None:
                continue
            try:
                cs.append(float(cl))
                ds.append(dt)
            except Exception:
                continue
        if not ds or not cs or len(ds) != len(cs):
            return None
        return {"dates": ds[-days:], "closes": cs[-days:]}
    except Exception:
        return None

def _finnhub_download(symbol: str, days: int) -> Optional[Dict[str, List]]:
    now = int(time())
    frm = now - days * 86400 * 3
    try:
        r = requests.get(
            FINNHUB_CANDLE_URL,
            params={
                "symbol": symbol,
                "resolution": "D",
                "from": frm,
                "to": now,
                "token": FINNHUB_API_KEY,
            },
            headers={"X-Finnhub-Secret": FINNHUB_SECRET},
            timeout=8,
        )
        r.raise_for_status()
        js = r.json()
        if js.get("s") != "ok" or not isinstance(js.get("c"), list) or not isinstance(js.get("t"), list):
            return None
        closes_raw = js["c"]
        ts_raw = js["t"]
        pairs = [(t, c) for t, c in zip(ts_raw, closes_raw) if c is not None]
        if not pairs:
            return None
        dates = [datetime.utcfromtimestamp(t).date().isoformat() for t, _ in pairs]
        closes = [float(c) for _, c in pairs]
        return {"dates": dates[-days:], "closes": closes[-days:]}
    except Exception:
        return None

# ---- NO CACHE here to avoid stale "Actuals" ----
def get_daily_closes(symbol: str, days: int) -> List[float]:
    sym = symbol.upper()
    days = max(2, min(int(days), 1825))

    # equities: yfinance -> TwelveData -> Finnhub
    if not _is_crypto(sym):
        for fn in (_yf_download, _twelve_download, _finnhub_download):
            data = fn(sym, days)
            if data and data.get("dates") and data.get("closes"):
                d, c = _drop_today_for_equities(data["dates"], data["closes"])
                if c:
                    return c[-days:]
        return []

    # crypto: TwelveData -> Finnhub (no drop-today)
    for fn in (_twelve_download, _finnhub_download):
        data = fn(sym, days)
        if data and data.get("closes"):
            return data["closes"][-days:]
    return []

# ---- NO CACHE here to avoid stale "Actuals" ----
def get_daily_closes_with_dates(symbol: str, days: int) -> Dict[str, List]:
    sym = symbol.upper()
    days = max(2, min(int(days), 1825))

    if not _is_crypto(sym):
        for fn in (_yf_download, _twelve_download, _finnhub_download):
            data = fn(sym, days)
            if data and data.get("dates") and data.get("closes"):
                d, c = _drop_today_for_equities(data["dates"], data["closes"])
                if d and c:
                    return {"dates": d[-days:], "closes": c[-days:]}
        return {"dates": [], "closes": []}

    for fn in (_twelve_download, _finnhub_download):
        data = fn(sym, days)
        if data and data.get("dates") and data.get("closes"):
            return {"dates": data["dates"][-days:], "closes": data["closes"][-days:]}
    return {"dates": [], "closes": []}

@lru_cache(maxsize=128)
def get_52w_stats(symbol: str) -> dict:
    closes = get_daily_closes(symbol, 300)  # ~252 trading days
    window = closes[-252:] if len(closes) >= 252 else closes
    if window:
        return {"high_52w": float(max(window)), "low_52w": float(min(window)), "market_cap": None, "sector": None}
    return {"high_52w": None, "low_52w": None, "market_cap": None, "sector": None}
