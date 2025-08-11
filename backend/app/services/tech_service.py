import os
import time
import requests
from typing import List, Dict, Optional, Iterable, Tuple
from dotenv import load_dotenv

load_dotenv()

# Twelve Data (primary)
TD_KEY = os.getenv("TWELVEDATA_API_KEY")
TD_TS_URL = "https://api.twelvedata.com/time_series"

# Alpha Vantage (fallback)
AV_KEY = os.getenv("ALPHAVANTAGE_API_KEY")  # optional
AV_TS_URL = "https://www.alphavantage.co/query"

if not TD_KEY:
    raise RuntimeError("Missing TWELVEDATA_API_KEY in environment")

# ----------------------------
# TTL cache (simple, in-memory)
# ----------------------------
def ttl_cache(ttl_seconds: int):
    def deco(fn):
        _cache: Dict[Tuple, Tuple[float, object]] = {}
        def wrapper(*args, **kwargs):
            key = (fn.__name__, args, tuple(sorted(kwargs.items())))
            now = time.time()
            if key in _cache:
                ts, val = _cache[key]
                if now - ts < ttl_seconds:
                    return val
            val = fn(*args, **kwargs)
            _cache[key] = (now, val)
            return val
        return wrapper
    return deco

# ----------------------------
# Fetch helpers
# ----------------------------
def _parse_td_series(js: dict) -> Optional[List[float]]:
    # Expect { "values": [{ "datetime": "...", "close": "..."}, ...], "status": "ok" }
    if not isinstance(js, dict) or js.get("status") == "error":
        return None
    values = js.get("values")
    if not isinstance(values, list) or not values:
        return None
    closes: List[float] = []
    for row in values:
        try:
            closes.append(float(row.get("close")))
        except (TypeError, ValueError):
            return None
    closes.reverse()  # oldest -> newest
    return closes

def _fetch_td_series(symbol: str, points: int) -> Optional[List[float]]:
    try:
        resp = requests.get(
            TD_TS_URL,
            params={
                "symbol": symbol,
                "interval": "1day",
                "outputsize": max(points, 120),
                "order": "DESC",
                "apikey": TD_KEY,
            },
            timeout=7,
        )
        resp.raise_for_status()
        js = resp.json()
        closes = _parse_td_series(js)
        if not closes:
            return None
        return closes[-points:] if len(closes) >= points else closes
    except Exception:
        return None

def _fetch_av_series(symbol: str, points: int) -> Optional[List[float]]:
    # Works for many equities/ETFs; not always for indexes like ^VIX/^TNX
    if not AV_KEY:
        return None
    try:
        resp = requests.get(
            AV_TS_URL,
            params={
                "function": "TIME_SERIES_DAILY",
                "symbol": symbol,
                "apikey": AV_KEY,
                "outputsize": "compact",
            },
            timeout=10,
        )
        resp.raise_for_status()
        js = resp.json()
        if "Note" in js or "Information" in js:
            return None
        series = js.get("Time Series (Daily)")
        if not isinstance(series, dict):
            return None
        rows = sorted(series.items(), key=lambda kv: kv[0])  # oldest -> newest
        closes: List[float] = []
        for _, vals in rows:
            try:
                closes.append(float(vals.get("4. close")))
            except (TypeError, ValueError):
                return None
        return closes[-points:] if len(closes) >= points else closes
    except Exception:
        return None

def _fetch_series_first(symbols: Iterable[str], points: int) -> Optional[List[float]]:
    """Try TD then AV for each candidate symbol; return first successful close array."""
    for sym in symbols:
        # Twelve Data first
        s = _fetch_td_series(sym, points)
        if s:
            return s
        # Alpha Vantage fallback
        s = _fetch_av_series(sym, points)
        if s:
            return s
    return None

def _base_variants(sym: str) -> List[str]:
    # For user tickers we don't usually need variants, but keep normalize to upper.
    return [sym.upper()]

def _macro_variants(sym: str) -> List[str]:
    """Return primary + fallbacks/proxies for macro series that are often plan-limited."""
    sym = sym.upper()
    if sym == "VIX":
        # TD sometimes uses VIX; AV may prefer ^VIX; VIXY is an ETF proxy
        return ["VIX", "^VIX", "VIXY"]
    if sym == "TNX":
        # 10Y yield: try TNX, ^TNX, US10Y (TD), then IEF ETF proxy
        return ["TNX", "^TNX", "US10Y", "IEF"]
    # ETFs typically work as-is
    return [sym]

# ----------------------------
# Indicators & stats
# ----------------------------
def _rsi_wilder(closes: List[float], period: int) -> List[float]:
    if len(closes) < period + 1:
        return []
    gains: List[float] = []
    losses: List[float] = []
    for i in range(1, period + 1):
        ch = closes[i] - closes[i - 1]
        gains.append(max(ch, 0.0))
        losses.append(max(-ch, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    rsi_vals: List[float] = []
    if avg_loss == 0:
        rsi_vals.append(100.0)
    else:
        rs = avg_gain / avg_loss
        rsi_vals.append(100 - (100 / (1 + rs)))
    for i in range(period + 1, len(closes)):
        ch = closes[i] - closes[i - 1]
        gain = max(ch, 0.0)
        loss = max(-ch, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0:
            rsi_vals.append(100.0)
        else:
            rs = avg_gain / avg_loss
            rsi_vals.append(100 - (100 / (1 + rs)))
    return rsi_vals

def _to_returns(series: List[float]) -> List[float]:
    """Convert price series to simple daily returns."""
    if not series or len(series) < 3:
        return []
    out: List[float] = []
    prev = series[0]
    for i in range(1, len(series)):
        cur = series[i]
        if prev == 0:
            prev = cur
            continue
        out.append((cur / prev) - 1.0)
        prev = cur
    return out

def _pearson_corr(a: List[float], b: List[float]) -> Optional[float]:
    n = min(len(a), len(b))
    if n < 5:
        return None
    a = a[-n:]
    b = b[-n:]
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((ai - mean_a) * (bi - mean_b) for ai, bi in zip(a, b))
    var_a = sum((ai - mean_a) ** 2 for ai in a)
    var_b = sum((bi - mean_b) ** 2 for bi in b)
    if var_a == 0 or var_b == 0:
        return None
    return cov / ((var_a ** 0.5) * (var_b ** 0.5))

def _pearson_corr_vec(a: List[float], b: List[float]) -> Optional[float]:
    """Same as _pearson_corr but assumes inputs already aligned/trimmed."""
    n = min(len(a), len(b))
    if n < 10:
        return None
    a = a[-n:]
    b = b[-n:]
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((ai - mean_a) * (bi - mean_b) for ai, bi in zip(a, b))
    var_a = sum((ai - mean_a) ** 2 for ai in a)
    var_b = sum((bi - mean_b) ** 2 for bi in b)
    if var_a == 0 or var_b == 0:
        return None
    return cov / ((var_a ** 0.5) * (var_b ** 0.5))

# ----------------------------
# Public API (with 120s TTL)
# ----------------------------
@ttl_cache(ttl_seconds=120)
def get_rsi(ticker: str, period: int = 14, days: int = 100) -> Dict:
    """
    Returns {"period": int, "values": List[float]}
    (Keep shape the same for your existing UI;
     routes layer can wrap into {ticker, period, last, series} if needed.)
    """
    if period < 2:
        period = 14
    need = max(days, period + 20)
    closes = _fetch_series_first(_base_variants(ticker), need)
    if not closes:
        return {"period": period, "values": []}
    rsi_vals = _rsi_wilder(closes, period)
    return {"period": period, "values": rsi_vals[-days:] if rsi_vals else []}

@ttl_cache(ttl_seconds=120)
def get_correlation(ticker: str, days: int = 60) -> Dict[str, float]:
    """
    Correlation of DAILY RETURNS vs a small universe (SPY, XLK, XLF, VIX, TNX).
    Returns {"SYMBOL": corr, ...}
    """
    # pull extra so we have enough points after converting to returns
    need = max(days + 30, 100)

    base_prices = _fetch_series_first(_base_variants(ticker), need)
    if not base_prices:
        return {}

    base_rets = _to_returns(base_prices)
    if not base_rets:
        return {}

    targets = {
        "SPY": _macro_variants("SPY"),
        "XLK": _macro_variants("XLK"),
        "XLF": _macro_variants("XLF"),
        "VIX": _macro_variants("VIX"),
        "TNX": _macro_variants("TNX"),
    }

    out: Dict[str, float] = {}
    for label, variants in targets.items():
        s_prices = _fetch_series_first(variants, need)
        if not s_prices:
            continue
        s_rets = _to_returns(s_prices)
        if not s_rets:
            continue

        # align by tail & cap to requested window of returns
        n = min(len(base_rets), len(s_rets), days)
        if n < 10:
            continue

        c = _pearson_corr_vec(base_rets[-n:], s_rets[-n:])
        if c is None:
            continue

        out[label] = float(round(c, 4))

    return out
