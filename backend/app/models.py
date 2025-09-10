# backend/app/models.py
from __future__ import annotations
# pyright: reportMissingImports=false, reportMissingModuleSource=false

import warnings
from typing import Dict, List, Tuple, Optional

import numpy as np
import pandas as pd


# =========================
# Utilities
# =========================
def _smape(y_true: np.ndarray, y_pred: np.ndarray) -> Optional[float]:
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    m = min(len(y_true), len(y_pred))
    if m < 5:
        return None
    y_true, y_pred = y_true[:m], y_pred[:m]
    denom = (np.abs(y_true) + np.abs(y_pred))
    denom = np.where(denom == 0.0, 1.0, denom)
    val = np.mean(2.0 * np.abs(y_pred - y_true) / denom) * 100.0
    if np.isfinite(val):
        return float(val)
    return None


# =========================
# Feature engineering
# =========================
def _rsi(close: pd.Series, window: int = 14) -> pd.Series:
    """Wilder’s RSI with safe defaults."""
    diff = close.diff()
    gain = diff.clip(lower=0.0)
    loss = -diff.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1.0 / window, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / window, adjust=False).mean()
    rs = avg_gain / (avg_loss.replace(0.0, np.nan))
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return rsi.fillna(50.0)


def build_supervised_features(
    close: pd.Series,
    max_lag: int = 30,
    windows: tuple[int, ...] = (7, 14, 21),
) -> pd.DataFrame:
    """
    Leakage-safe features from Close:
      - price & return lags
      - rolling mean/std/min/max of price
      - rolling mean/std of returns
      - RSI(14), realized vol(21)
    Target: next-period return (ret[t+1]).
    """
    s = pd.Series(close).astype(float).copy()
    s.index = pd.to_datetime(s.index)

    ret = s.pct_change()
    logret = np.log(s).diff()

    df = pd.DataFrame({
        "Close": s,
        "ret": ret,
        "logret": logret,
    })

    # lags (price + return)
    for l in range(1, max_lag + 1):
        df[f"lag_close_{l}"] = df["Close"].shift(l)
        df[f"lag_ret_{l}"] = df["ret"].shift(l)

    # rolling features (price + returns)
    for w in windows:
        # price
        df[f"roll_close_mean_{w}"] = df["Close"].rolling(w).mean()
        df[f"roll_close_std_{w}"] = df["Close"].rolling(w).std()
        df[f"roll_close_min_{w}"] = df["Close"].rolling(w).min()
        df[f"roll_close_max_{w}"] = df["Close"].rolling(w).max()
        # returns
        df[f"roll_ret_mean_{w}"] = df["ret"].rolling(w).mean()
        df[f"roll_ret_std_{w}"] = df["ret"].rolling(w).std()

    # momentum/volatility
    df["rsi_14"] = _rsi(df["Close"], 14)
    df["rv_21"] = df["ret"].rolling(21).std() * np.sqrt(252.0)

    # target is next period return (more stationary)
    df["y_next_ret"] = df["ret"].shift(-1)

    # drop NaNs (starts of lags/rolling; last row due to shift(-1))
    df = df.dropna()
    return df


def _rebuild_features_for_step(
    hist_close: List[float],
    max_lag: int = 30,
    windows: tuple[int, ...] = (7, 14, 21),
) -> Tuple[np.ndarray, List[str]]:
    """
    Recompute the latest feature vector from a synthetic close history.
    Used during multi-step recursion so rollings/RSI evolve with predictions.
    """
    s = pd.Series(hist_close, dtype=float)
    ret = s.pct_change()
    logret = np.log(s).diff()

    feats = {
        "Close": s.iloc[-1],
        "ret": ret.iloc[-1],
        "logret": logret.iloc[-1],
    }

    for l in range(1, max_lag + 1):
        if len(s) - l <= 0:
            feats[f"lag_close_{l}"] = np.nan
            feats[f"lag_ret_{l}"] = np.nan
        else:
            feats[f"lag_close_{l}"] = s.iloc[-l]
            feats[f"lag_ret_{l}"] = ret.iloc[-l]

    for w in windows:
        feats[f"roll_close_mean_{w}"] = s.rolling(w).mean().iloc[-1]
        feats[f"roll_close_std_{w}"] = s.rolling(w).std().iloc[-1]
        feats[f"roll_close_min_{w}"] = s.rolling(w).min().iloc[-1]
        feats[f"roll_close_max_{w}"] = s.rolling(w).max().iloc[-1]
        feats[f"roll_ret_mean_{w}"] = ret.rolling(w).mean().iloc[-1]
        feats[f"roll_ret_std_{w}"] = ret.rolling(w).std().iloc[-1]

    feats["rsi_14"] = _rsi(s, 14).iloc[-1]
    feats["rv_21"] = ret.rolling(21).std().iloc[-1] * np.sqrt(252.0)

    cols = list(feats.keys())
    X = np.array([feats[c] for c in cols], dtype=float)
    if np.isnan(X).any():
        X = np.nan_to_num(X, nan=np.nanmean(X[np.isfinite(X)]) if np.isfinite(X).any() else 0.0)
    return X, cols


# =========================
# Models (RF/XGB on returns; ARIMA baseline on price)
# =========================
def _train_rf_xgb_common_with_val(
    close: pd.Series,
    horizon: int,
    which: str,
) -> Tuple[float, List[float], Optional[float]]:
    df = build_supervised_features(close, max_lag=30, windows=(7, 14, 21))
    y = df["y_next_ret"].values.astype(float)
    X = df.drop(columns=["y_next_ret"]).values.astype(float)
    cols = [c for c in df.columns if c != "y_next_ret"]

    if len(y) < 120:
        raise ValueError(f"Not enough data for {which} (need >=120 rows)")

    split = int(len(y) * 0.85)
    X_train, y_train = X[:split], y[:split]
    X_val = X[split:]
    last_close = float(df["Close"].iloc[-1])

    # build model
    if which == "rf":
        try:
            from sklearn.ensemble import RandomForestRegressor
            from sklearn.pipeline import Pipeline
            from sklearn.preprocessing import StandardScaler
        except Exception as e:
            raise ImportError("scikit-learn not installed") from e

        model = Pipeline([
            ("scaler", StandardScaler()),
            ("rf", RandomForestRegressor(
                n_estimators=500,
                max_depth=None,
                min_samples_leaf=2,
                random_state=42,
                n_jobs=-1,
            )),
        ])
    elif which == "xgb":
        try:
            import xgboost as xgb
            from sklearn.pipeline import Pipeline
            from sklearn.preprocessing import StandardScaler
        except Exception as e:
            raise ImportError("xgboost/scikit-learn not installed") from e

        model = Pipeline([
            ("scaler", StandardScaler()),
            ("xgb", xgb.XGBRegressor(
                n_estimators=800,
                max_depth=6,
                learning_rate=0.03,
                subsample=0.9,
                colsample_bytree=0.9,
                reg_lambda=1.0,
                random_state=42,
                n_jobs=4,
                tree_method="hist",
            )),
        ])
    else:
        raise ValueError("which must be 'rf' or 'xgb'")

    # fit
    model.fit(X_train, y_train)

    # validation sMAPE on *prices* (predict next close = close[t]*(1+ret_hat))
    val_smape = None
    if len(X_val) >= 5:
        pred_ret_val = model.predict(X_val)
        close_now = df["Close"].iloc[split:].values
        close_next_actual = df["Close"].shift(-1).iloc[split:].values
        pred_next_close = close_now * (1.0 + pred_ret_val)
        # drop last NaN from shift(-1) by aligning lengths
        m = min(len(pred_next_close), len(close_next_actual))
        val_smape = _smape(close_next_actual[:m], pred_next_close[:m])

    # 1-step forecast from last row
    X_last = X[-1]
    next_ret = float(model.predict(X_last.reshape(1, -1))[0])
    next_price = float(last_close * (1.0 + next_ret))
    if horizon <= 1:
        return next_price, [next_price], val_smape

    # multi-step with rolling feature refresh
    max_need = max(30, 21, 14) + 3
    hist = list(df["Close"].tail(max_need).astype(float).values)

    path_prices: List[float] = []
    for _ in range(horizon):
        X_step, cols_step = _rebuild_features_for_step(hist, max_lag=30, windows=(7, 14, 21))
        if cols_step != cols:
            idx = [cols_step.index(c) for c in cols]
            X_feed = X_step[idx]
        else:
            X_feed = X_step

        step_ret = float(model.predict(X_feed.reshape(1, -1))[0])
        next_p = float(hist[-1] * (1.0 + step_ret))
        path_prices.append(next_p)
        hist.append(next_p)
        if len(hist) > max_need:
            hist = hist[-max_need:]

    return path_prices[0], path_prices, val_smape


def train_predict_rf(close: pd.Series, horizon: int = 1) -> Tuple[float, List[float]]:
    nxt, path, _ = _train_rf_xgb_common_with_val(close, horizon, which="rf")
    return nxt, path


def train_predict_xgb(close: pd.Series, horizon: int = 1) -> Tuple[float, List[float]]:
    nxt, path, _ = _train_rf_xgb_common_with_val(close, horizon, which="xgb")
    return nxt, path


def _train_predict_arima_with_val(close: pd.Series, horizon: int = 1) -> Tuple[float, List[float], Optional[float]]:
    """ARIMA baseline on price with a simple validation sMAPE."""
    val_smape = None
    # ---- validation on split ----
    try:
        s = pd.Series(close).astype(float)
        s.index = pd.to_datetime(s.index)
        if len(s) >= 60:
            split = int(len(s) * 0.85)
            train = s.iloc[:split]
            val = s.iloc[split:]
            # Prefer pmdarima for convenience
            try:
                import pmdarima as pm
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    mdl = pm.auto_arima(
                        train.values,
                        seasonal=False,
                        error_action="ignore",
                        suppress_warnings=True,
                        stepwise=True,
                        max_p=3,
                        max_q=3,
                    )
                    # produce a multi-step forecast for the entire validation span
                    fc = mdl.predict(n_periods=len(val))
                    # Compare fc (pred next prices, starting at split) to actual val prices
                    val_smape = _smape(val.values, np.asarray(fc, dtype=float))
            except Exception:
                try:
                    from statsmodels.tsa.arima.model import ARIMA
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        res = ARIMA(train.values, order=(1, 1, 1)).fit()
                        fc = res.forecast(steps=len(val))
                        val_smape = _smape(val.values, np.asarray(fc, dtype=float))
                except Exception:
                    val_smape = None
    except Exception:
        val_smape = None

    # ---- production forecast from full series ----
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
            return out[0], out, val_smape
    except Exception:
        pass

    try:
        from statsmodels.tsa.arima.model import ARIMA
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            res = ARIMA(close.values, order=(1, 1, 1)).fit()
            fc = res.forecast(steps=horizon)
            out = list(map(float, fc))
            return out[0], out, val_smape
    except Exception as e:
        raise ImportError("Neither pmdarima nor statsmodels is available") from e


def train_predict_arima(close: pd.Series, horizon: int = 1) -> Tuple[float, List[float]]:
    nxt, path, _ = _train_predict_arima_with_val(close, horizon)
    return nxt, path


# =========================
# Orchestrator (+ Ensemble)
# =========================
def predict_all_models(close: pd.Series, horizon: int = 1) -> Dict[str, Dict]:
    """
    Train and predict with available models. Returns:
      {
        "RandomForest": {"next": float, "path": [...], "val_smape": float? } | {"error": "..."},
        "XGBoost":      {"next": float, "path": [...], "val_smape": float? } | {"error": "..."},
        "ARIMA":        {"next": float, "path": [...], "val_smape": float? } | {"error": "..."},
        "Ensemble":     {"next": float, "path": [...], "weights": {"RandomForest": w, ...}}
      }
    """
    results: Dict[str, Dict] = {}

    # --- Individual models (return their own val sMAPE when available)
    vals: Dict[str, Optional[float]] = {}
    paths: Dict[str, List[float]] = {}

    # RF
    try:
        nxt, path, sm = _train_rf_xgb_common_with_val(close, horizon, which="rf")
        results["RandomForest"] = {"next": float(nxt), "path": list(map(float, path)), "val_smape": sm}
        vals["RandomForest"] = sm
        paths["RandomForest"] = path
    except Exception as e:
        results["RandomForest"] = {"error": str(e)}

    # XGB
    try:
        nxt, path, sm = _train_rf_xgb_common_with_val(close, horizon, which="xgb")
        results["XGBoost"] = {"next": float(nxt), "path": list(map(float, path)), "val_smape": sm}
        vals["XGBoost"] = sm
        paths["XGBoost"] = path
    except Exception as e:
        results["XGBoost"] = {"error": str(e)}

    # ARIMA
    try:
        nxt, path, sm = _train_predict_arima_with_val(close, horizon)
        results["ARIMA"] = {"next": float(nxt), "path": list(map(float, path)), "val_smape": sm}
        vals["ARIMA"] = sm
        paths["ARIMA"] = path
    except Exception as e:
        results["ARIMA"] = {"error": str(e)}

    # --- Ensemble (inverse-sMAPE weights; fallback to equal)
    # collect available models with a path
    available = [k for k in ("RandomForest", "XGBoost", "ARIMA") if k in paths]
    if available:
        eps = 1e-6
        # weights: 1/(eps + smape); if smape missing, use average of available
        smapes = [vals.get(k) for k in available]
        avg_smape = (sum([v for v in smapes if v is not None]) / max(1, sum(v is not None for v in smapes))) if any(v is not None for v in smapes) else None
        raw_weights = []
        for k in available:
            sm = vals.get(k)
            if sm is None:
                sm = avg_smape if avg_smape is not None else 1.0
            raw_weights.append(1.0 / (eps + float(sm)))
        wsum = sum(raw_weights) or 1.0
        weights = {k: float(w / wsum) for k, w in zip(available, raw_weights)}

        # blend paths step-by-step
        max_len = max(len(paths[k]) for k in available)
        ens_path: List[float] = []
        for i in range(max_len):
            acc = 0.0
            for k in available:
                if i < len(paths[k]):
                    acc += weights[k] * float(paths[k][i])
                else:
                    # if a model path is shorter (shouldn't happen here), ignore extra steps
                    pass
            ens_path.append(acc)

        results["Ensemble"] = {
            "next": float(ens_path[0]),
            "path": list(map(float, ens_path)),
            "weights": weights,
        }

    return results
