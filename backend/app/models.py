# backend/app/models.py
from __future__ import annotations
# pyright: reportMissingImports=false, reportMissingModuleSource=false

import warnings
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd


# ---------- Feature engineering ----------
def build_supervised_features(close: pd.Series, max_lag: int = 30) -> pd.DataFrame:
    """
    Build supervised features from a Close series: lags + rolling stats.
    """
    s = pd.Series(close).astype(float).copy()
    s.index = pd.to_datetime(s.index)

    df = pd.DataFrame({"Close": s})
    for l in range(1, max_lag + 1):
        df[f"lag_{l}"] = df["Close"].shift(l)

    for w in (7, 14, 21):
        df[f"roll_mean_{w}"] = df["Close"].rolling(w).mean()
        df[f"roll_std_{w}"] = df["Close"].rolling(w).std()
        df[f"roll_min_{w}"] = df["Close"].rolling(w).min()
        df[f"roll_max_{w}"] = df["Close"].rolling(w).max()

    df = df.dropna()
    return df


def _multi_step_walk(regressor, last_row: np.ndarray, steps: int, backfill_fn) -> List[float]:
    """
    Multi-step forecast by feeding each prediction back into the features.
    """
    preds: List[float] = []
    feat = last_row
    for _ in range(steps):
        yhat = float(regressor.predict(feat.reshape(1, -1))[0])
        preds.append(yhat)
        feat = backfill_fn(preds)
    return preds


# ---------- Models ----------
def train_predict_rf(close: pd.Series, horizon: int = 1) -> Tuple[float, List[float]]:
    # Import inside the function to avoid module import errors at app startup
    try:
        from sklearn.ensemble import RandomForestRegressor
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except Exception as e:
        raise ImportError("scikit-learn not installed") from e

    df = build_supervised_features(close)
    y = df["Close"].values
    X = df.drop(columns=["Close"]).values
    if len(y) < 60:
        raise ValueError("Not enough data for RandomForest")

    split = int(len(y) * 0.85)
    X_train, y_train = X[:split], y[:split]
    X_last = X[-1]

    model = Pipeline([
        ("scaler", StandardScaler()),
        ("rf", RandomForestRegressor(n_estimators=300, random_state=42, n_jobs=-1)),
    ])
    model.fit(X_train, y_train)

    cols = df.drop(columns=["Close"]).columns.tolist()

    def backfill_fn(preds: List[float]) -> np.ndarray:
        xdict = dict(zip(cols, X_last.tolist()))
        last_close = float(close.iloc[-1])
        synthetic = [last_close] + preds
        for k in range(1, 31):
            key = f"lag_{k}"
            if key in xdict and len(synthetic) >= k:
                xdict[key] = synthetic[-k]
        return np.array([xdict[c] for c in cols], dtype=float)

    one = float(model.predict(X_last.reshape(1, -1))[0])
    if horizon <= 1:
        return one, [one]
    multi = _multi_step_walk(model, X_last.astype(float), horizon, backfill_fn)
    return multi[0], multi


def train_predict_xgb(close: pd.Series, horizon: int = 1) -> Tuple[float, List[float]]:
    try:
        import xgboost as xgb
    except Exception as e:
        raise ImportError("xgboost not installed") from e

    df = build_supervised_features(close)
    y = df["Close"].values
    X = df.drop(columns=["Close"]).values
    if len(y) < 60:
        raise ValueError("Not enough data for XGBoost")

    split = int(len(y) * 0.85)
    X_train, y_train = X[:split], y[:split]
    X_last = X[-1]

    booster = xgb.XGBRegressor(
        n_estimators=600,
        max_depth=6,
        learning_rate=0.03,
        subsample=0.9,
        colsample_bytree=0.9,
        random_state=42,
        n_jobs=4,
    )
    booster.fit(X_train, y_train)

    cols = df.drop(columns=["Close"]).columns.tolist()

    def backfill_fn(preds: List[float]) -> np.ndarray:
        xdict = dict(zip(cols, X_last.tolist()))
        last_close = float(close.iloc[-1])
        synthetic = [last_close] + preds
        for k in range(1, 31):
            key = f"lag_{k}"
            if key in xdict and len(synthetic) >= k:
                xdict[key] = synthetic[-k]
        return np.array([xdict[c] for c in cols], dtype=float)

    one = float(booster.predict(X_last.reshape(1, -1))[0])
    if horizon <= 1:
        return one, [one]
    multi = _multi_step_walk(booster, X_last.astype(float), horizon, backfill_fn)
    return multi[0], multi


def train_predict_arima(close: pd.Series, horizon: int = 1) -> Tuple[float, List[float]]:
    # Prefer pmdarima; fallback to statsmodels; otherwise error.
    try:
        import pmdarima as pm
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model = pm.auto_arima(
                close.values,
                seasonal=False,
                error_action="ignore",
                suppress_warnings=True,
                stepwise=True,
                max_p=3,
                max_q=3,
            )
            fc = model.predict(n_periods=horizon)
            out = list(map(float, fc))
            return out[0], out
    except Exception:
        pass

    try:
        from statsmodels.tsa.arima.model import ARIMA
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            res = ARIMA(close.values, order=(1, 1, 1)).fit()
            fc = res.forecast(steps=horizon)
            out = list(map(float, fc))
            return out[0], out
    except Exception as e:
        raise ImportError("Neither pmdarima nor statsmodels is available") from e


# ---------- Orchestrator ----------
def predict_all_models(close: pd.Series, horizon: int = 1) -> Dict[str, Dict]:
    """
    Train and predict with available models. Returns:
      {
        "RandomForest": {"next": float, "path": [...] } | {"error": "..."},
        "XGBoost":     {"next": float, "path": [...] } | {"error": "..."},
        "ARIMA":       {"next": float, "path": [...] } | {"error": "..."}
      }
    """
    results: Dict[str, Dict] = {}

    # RandomForest
    try:
        nxt, path = train_predict_rf(close, horizon)
        results["RandomForest"] = {"next": float(nxt), "path": list(map(float, path))}
    except Exception as e:
        results["RandomForest"] = {"error": str(e)}

    # XGBoost
    try:
        nxt, path = train_predict_xgb(close, horizon)
        results["XGBoost"] = {"next": float(nxt), "path": list(map(float, path))}
    except Exception as e:
        results["XGBoost"] = {"error": str(e)}

    # ARIMA
    try:
        nxt, path = train_predict_arima(close, horizon)
        results["ARIMA"] = {"next": float(nxt), "path": list(map(float, path))}
    except Exception as e:
        results["ARIMA"] = {"error": str(e)}

    return results
