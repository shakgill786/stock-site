# app/services/movers_service.py
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Iterable
import math
import yfinance as yf

@dataclass
class TickerMover:
    symbol: str
    last: float
    prev_close: float
    change: float
    change_pct: float

    @classmethod
    def from_yf(cls, symbol: str) -> "TickerMover | None":
        try:
            t = yf.Ticker(symbol)
            fi = getattr(t, "fast_info", None)
            last = None
            prev = None

            # Prefer fast_info where available
            if fi:
                last = float(getattr(fi, "last_price", None) or 0) or None
                prev = float(getattr(fi, "previous_close", None) or 0) or None

            # Fallback to history if needed
            if last is None or prev is None:
                hist = t.history(period="5d", interval="1d", auto_adjust=False)
                if hist is not None and not hist.empty:
                    closes = hist["Close"].dropna().tolist()
                    if len(closes) >= 1:
                        last = float(closes[-1])
                    if len(closes) >= 2:
                        prev = float(closes[-2])

            if last is None or prev is None or prev <= 0:
                return None

            change = last - prev
            change_pct = (change / prev) * 100.0
            return cls(symbol=symbol, last=last, prev_close=prev, change=change, change_pct=change_pct)
        except Exception:
            return None


DEFAULT_UNIVERSE = [
    # Big liquid names; tweak as you like
    "AAPL","MSFT","NVDA","AMZN","GOOGL","META","AVGO","TSLA","AMD","NFLX",
    "ORCL","CRM","ADBE","INTC","CSCO","PEP","KO","PFE","XOM","CVX",
    "JPM","BAC","GS","HD","PG","TSM","V","MA","TXN","QCOM",
]

def fetch_movers(symbols: Iterable[str] = None, min_price: float = 1.0) -> Dict[str, Any]:
    symbols = list(symbols or DEFAULT_UNIVERSE)
    rows: List[TickerMover] = []
    for s in symbols:
        row = TickerMover.from_yf(s)
        if row and row.last >= min_price:
            rows.append(row)

    # If *everything* failed, return a stable empty set rather than nonsense fallback
    if not rows:
        return {"source": "empty", "items": []}

    # Sorts
    gainers = sorted(rows, key=lambda r: r.change_pct, reverse=True)[:25]
    losers  = sorted(rows, key=lambda r: r.change_pct)[:25]

    def pack(lst: List[TickerMover]) -> List[Dict[str, Any]]:
        return [
            {
                "symbol": r.symbol,
                "last": round(r.last, 2),
                "prev_close": round(r.prev_close, 2),
                "change": round(r.change, 2),
                "change_pct": round(r.change_pct, 2),
            }
            for r in lst
        ]

    return {
        "source": "yfinance",
        "gainers": pack(gainers),
        "losers": pack(losers),
        "universe": symbols,
    }
