# app/services/news_service.py
from __future__ import annotations
import os, re, math, datetime as dt
from typing import List, Dict, Any, Optional, Tuple
import httpx

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

_ALPHA = os.getenv("ALPHAVANTAGE_API_KEY", "").strip()
_REDDIT_UA = "stock-sentiment/1.0"
_analyzer = SentimentIntensityAnalyzer()

# -------- utils --------
_TICKER_RE = re.compile(r"\b[A-Z]{1,5}(?:\.[A-Z])?\b")

def _today_utc():
    return dt.datetime.utcnow().date()

def _iso_date(s: str) -> str:
    try:
        return str(dt.date.fromisoformat(s[:10]))
    except Exception:
        try:
            return str(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).date())
        except Exception:
            return str(_today_utc())

def _score_text(txt: str) -> float:
    if not txt:
        return 0.0
    vs = _analyzer.polarity_scores(txt or "")
    return float(vs.get("compound", 0.0))  # [-1..1]

def _norm_symbol(s: str) -> str:
    return (s or "").strip().upper()

# -------- vendors --------
async def _fetch_av_news(ticker: str, limit: int = 50) -> List[Dict[str, Any]]:
    """Alpha Vantage NEWS_SENTIMENT (if key present)."""
    if not _ALPHA:
        return []
    url = "https://www.alphavantage.co/query"
    params = {
        "function": "NEWS_SENTIMENT",
        "tickers": _norm_symbol(ticker),
        "sort": "LATEST",
        "apikey": _ALPHA,
        "limit": min(max(int(limit), 10), 200)
    }
    async with httpx.AsyncClient(timeout=12.0) as client:
        r = await client.get(url, params=params)
        data = r.json() if r.content else {}
    feed = data.get("feed") or []
    out = []
    for it in feed:
        # AV has fields: title, time_published (YYYYMMDDTHHMMSS), summary, source, url, ticker_sentiment[]
        tp = str(it.get("time_published", ""))
        # convert to ISO date
        if len(tp) >= 8:
            d = f"{tp[0:4]}-{tp[4:6]}-{tp[6:8]}"
        else:
            d = _iso_date(tp)
        out.append({
            "date": d,
            "title": it.get("title") or "",
            "summary": it.get("summary") or "",
            "source": it.get("source") or "",
            "url": it.get("url") or "",
        })
    return out

async def _fetch_reddit_fallback(ticker: str, limit: int = 40) -> List[Dict[str, Any]]:
    """Public JSON from r/stocks & r/investing as a soft fallback (headlines only)."""
    subs = ["stocks", "investing"]
    out: List[Dict[str, Any]] = []
    headers = {"User-Agent": _REDDIT_UA}
    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        for sub in subs:
            try:
                url = f"https://www.reddit.com/r/{sub}/search.json"
                params = {"q": _norm_symbol(ticker), "restrict_sr": "on", "sort": "new", "limit": str(limit)}
                r = await client.get(url, params=params)
                j = r.json()
                for child in j.get("data", {}).get("children", []):
                    d = child.get("data", {})
                    title = d.get("title", "")
                    if not title:
                        continue
                    created_utc = dt.datetime.utcfromtimestamp(d.get("created_utc", 0)).date()
                    out.append({
                        "date": str(created_utc),
                        "title": title,
                        "summary": "",
                        "source": f"r/{sub}",
                        "url": f"https://www.reddit.com{d.get('permalink', '')}",
                    })
            except Exception:
                continue
    return out

# -------- public surface --------
async def fetch_news_headlines(ticker: str, limit: int = 80) -> List[Dict[str, Any]]:
    """Try AV first, fall back to Reddit search."""
    av = await _fetch_av_news(ticker, limit=limit)
    if av:
        return av[:limit]
    rb = await _fetch_reddit_fallback(ticker, limit=min(limit, 50))
    return rb[:limit]

async def score_headlines(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for it in (items or []):
        text = " ".join([it.get("title") or "", it.get("summary") or ""]).strip()
        score = _score_text(text)
        it2 = {**it, "sentiment": score}
        out.append(it2)
    return out

def aggregate_daily_sentiment(scored: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return sorted list [{date, mean, count}]"""
    by: Dict[str, List[float]] = {}
    for it in (scored or []):
        d = _iso_date(it.get("date") or "")
        s = it.get("sentiment")
        if isinstance(s, (int, float)):
            by.setdefault(d, []).append(float(s))
    rows = []
    for d, vals in by.items():
        if not vals: 
            continue
        mean = sum(vals) / len(vals)
        rows.append({"date": d, "mean": mean, "count": len(vals)})
    rows.sort(key=lambda x: x["date"])
    return rows

def correlate_with_returns(dates: List[str], closes: List[float], daily_sent: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Join by date; compute daily % return and Pearson r with sentiment."""
    # daily returns from closes (aligned by date strings)
    # we assume dates most-recent-last (your service guarantees)
    paired: Dict[str, float] = {}
    for d, c in zip(dates, closes):
        try:
            ds = str(d)[:10]
            paired[ds] = float(c)
        except Exception:
            continue

    # compute returns (prev->today)
    keys = sorted(paired.keys())
    returns: Dict[str, float] = {}
    for i in range(1, len(keys)):
        prev, cur = paired[keys[i-1]], paired[keys[i]]
        if prev and not math.isnan(prev) and not math.isnan(cur):
            returns[keys[i]] = ((cur - prev) / prev)

    # align to sentiment means
    xs, ys, pts = [], [], []
    sent_map = {x["date"]: float(x["mean"]) for x in daily_sent}
    for d, r in returns.items():
        if d in sent_map:
            xs.append(sent_map[d])
            ys.append(r)
            pts.append({"date": d, "sent": sent_map[d], "ret": r})

    # Pearson r
    def pearson(a, b):
        n = len(a)
        if n < 2:
            return float("nan")
        ma = sum(a) / n
        mb = sum(b) / n
        cov = sum((x - ma)*(y - mb) for x, y in zip(a, b))
        va = sum((x - ma)**2 for x in a)
        vb = sum((y - mb)**2 for y in b)
        if va <= 0 or vb <= 0:
            return float("nan")
        return cov / math.sqrt(va*vb)

    r = pearson(xs, ys) if xs and ys else float("nan")
    return {"n": len(xs), "pearson_r": r, "pairs": pts}

# -------- Topic modeling (optional) --------
def topic_model(items: List[Dict[str, Any]], k: int = 5) -> Dict[str, Any]:
    """KMeans over TF-IDF; returns top terms per cluster + membership."""
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.cluster import KMeans
    except Exception:
        return {"error": "scikit-learn not installed"}
    texts = []
    for it in items:
        txt = " ".join([(it.get("title") or ""), (it.get("summary") or "")]).strip()
        if txt:
            texts.append(txt)
    if len(texts) < max(k, 3):
        return {"k": 0, "topics": [], "labels": []}
    vec = TfidfVectorizer(max_features=5000, stop_words="english")
    X = vec.fit_transform(texts)
    k = max(2, min(k, 10))
    km = KMeans(n_clusters=k, n_init="auto", random_state=42)
    km.fit(X)
    order_centroids = km.cluster_centers_.argsort()[:, ::-1]
    terms = vec.get_feature_names_out()
    topics = []
    for i in range(k):
        top_terms = [terms[idx] for idx in order_centroids[i, :10]]
        topics.append({"topic": i, "terms": top_terms})
    labels = list(map(int, km.labels_))
    return {"k": k, "topics": topics, "labels": labels}
