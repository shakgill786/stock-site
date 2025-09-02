# backend/app/services/finance_service.py

import os
import requests
from fastapi import HTTPException
from datetime import date, datetime, timedelta
from time import time
from typing import List, Tuple, Dict, Optional
from functools import lru_cache
from dotenv import load_dotenv

# Timezone for US equities market logic
try:
    from zoneinfo import ZoneInfo  # py3.9+
except Exception:  # pragma: no cover
    ZoneInfo = None

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

NY_TZ = ZoneInfo("America/New_York") if ZoneInfo else None

def _ny_now() -> datetime:
    if NY_TZ:
        return datetime.now(NY_TZ)
    return datetime.now()

def _is_crypto(symbol: str) -> bool:
    return "-" in (symbol or "")

def _filter_weekends(dates: List[str], closes: List[float]) -> Tuple[List[str], List[float]]:
    """Remove Sat/Sun rows; keep list aligned."""
    if not dates or not closes or len(dates) != len(closes):
        return dates or [], closes or []
    out_d, out_c = [], []
    for d, c in zip(dates, closes):
        try:
            dd = date.fromisoformat(str(d)[:10])
            if dd.weekday() >= 5:  # 5=Sat, 6=Sun
                continue
            out_d.append(dd.isoformat())
            out_c.append(float(c))
        except Exception:
            out_d.append(str(d)[:10])
            out_c.append(float(c))
    return out_d, out_c

def _market_closed_now() -> bool:
    """
    Heuristic: consider the market 'closed' after ~6pm ET or on weekends.
    Keeps it simple; avoids special holidays/half-days.
    """
    now = _ny_now()
    if now.weekday() >= 5:
        return True
    return now.hour >= 18  # 6pm ET

def _normalize_equity_calendar(dates: List[str], closes: List[float]) -> Tuple[List[str], List[float]]:
    """
    Normalize equities daily series:
      - drop weekends
      - drop 'today' only if market is NOT yet closed
    """
    d, c = _filter_weekends(dates, closes)
    if not d or not c:
        return d, c

    today_iso = _ny_now().date().isoformat()
    # If last row is "today" but the session isn't closed yet, drop it (intraday placeholder).
    if d and d[-1] == today_iso and not _market_closed_now():
        return d[:-1], c[:-1]
    return d, c

# -------------------------
# Quote / Earnings / Market
# -------------------------

@lru_cache(maxsize=128)
def get_quote(ticker: str):
    """
    Quote with fields aligned to our normalized daily series:
      - last_close: from normalized /closes series (authoritative session close)
      - last_close_date: ISO date of that last_close
      - current_price/change_pct: from live quote if available; otherwise equals last_close/0.0
    """
    symbol = ticker.upper()

    live_price = None  # from Finnhub/Twelve/AV
    # 1) Finnhub: get current/prev (but we'll trust daily series for last_close)
    try:
        r1 = requests.get(
            FINNHUB_QUOTE_URL,
            params={"symbol": symbol, "token": FINNHUB_API_KEY},
            headers={"X-Finnhub-Secret": FINNHUB_SECRET},
            timeout=6,
        )
        r1.raise_for_status()
        d1 = r1.json()
        c = d1.get("c")
        if c is not None:
            live_price = float(c)
    except Exception:
        pass

    # 2) Twelve Data (if we still need live price)
    if live_price is None:
        try:
            r2 = requests.get(TD_QUOTE_URL, params={"symbol": symbol, "apikey": TD_KEY}, timeout=6)
            r2.raise_for_status()
            js2 = r2.json()
            if isinstance(js2, dict) and js2.get("status") == "error":
                raise ValueError(js2.get("message", "TD status=error"))
            if isinstance(js2, dict) and "close" in js2:
                live_price = float(js2["close"])
            elif isinstance(js2, dict) and symbol in js2:
                info = js2[symbol]
                live_price = float(info.get("close"))
        except Exception:
            pass

    # Build authoritative last_close + date from our own normalized daily series
    series = get_daily_closes_with_dates(symbol, 20)
    ds = list(series.get("dates") or [])
    cs = [float(x) for x in (series.get("closes") or [])]
    if not ds or not cs:
        # last resort: keep service resilient
        if live_price is not None:
            return {
                "ticker": symbol,
                "last_close": round(float(live_price), 2),
                "last_close_date": None,
                "current_price": round(float(live_price), 2),
                "change_pct": 0.0,
            }
        raise HTTPException(502, f"Could not build quote for {symbol} (no daily series)")

    last_close_val = float(cs[-1])
    last_close_date = str(ds[-1])[:10]
    if live_price is None:
        live_price = last_close_val

    pct = 0.0 if last_close_val == 0 else round(((live_price - last_close_val) / last_close_val) * 100.0, 2)

    return {
        "ticker": symbol,
        "last_close": round(last_close_val, 2),
        "last_close_date": last_close_date,
        "current_price": round(float(live_price), 2),
        "change_pct": pct,
    }

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
            auto_adjust=False,  # use unadjusted Close to match most APIs/Yahoo "Close"
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

def _download_any_equity(symbol: str, days: int) -> Dict[str, List]:
    """Try yfinance -> TwelveData -> Finnhub in that order."""
    for fn in (_yf_download, _twelve_download, _finnhub_download):
        data = fn(symbol, days)
        if data and data.get("dates") and data.get("closes"):
            return data
    return {"dates": [], "closes": []}

# ---- NO CACHE here to avoid stale "Actuals" ----
def get_daily_closes(symbol: str, days: int) -> List[float]:
    sym = symbol.upper()
    days = max(2, min(int(days), 1825))

    if not _is_crypto(sym):
        data = _download_any_equity(sym, days + 5)  # small buffer
        d, c = data.get("dates") or [], data.get("closes") or []
        d, c = _normalize_equity_calendar(d, c)
        return (c[-days:] if c else [])
    else:
        # crypto: TwelveData -> Finnhub (no calendar normalization)
        for fn in (_twelve_download, _finnhub_download):
            data = fn(sym, days + 5)
            if data and data.get("closes"):
                return data["closes"][-days:]
        return []

# ---- NO CACHE here to avoid stale "Actuals" ----
def get_daily_closes_with_dates(symbol: str, days: int) -> Dict[str, List]:
    sym = symbol.upper()
    days = max(2, min(int(days), 1825))

    if not _is_crypto(sym):
        data = _download_any_equity(sym, days + 5)  # buffer to survive a dropped 'today'
        d, c = data.get("dates") or [], data.get("closes") or []
        d, c = _normalize_equity_calendar(d, c)
        d = d[-days:] if d else []
        c = c[-days:] if c else []
        return {"dates": d, "closes": c}

    # crypto: pass through
    for fn in (_twelve_download, _finnhub_download):
        data = fn(sym, days + 5)
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
