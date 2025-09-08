// frontend/src/auth/AuthContext.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as api from "../api";

const AuthCtx = createContext(null);

// ----- small helpers for local "profile" (name, etc.) -----
// Always coerce to string before .toLowerCase() to avoid crashes
const safeScope = (u, fallback = "guest") => {
  const raw = (u?.id ?? u?.email ?? fallback);
  return String(raw || fallback).toLowerCase();
};

const profileKeyFor = (u) => `PROFILE_V1__${safeScope(u)}`;

const readProfile = (u) => {
  try {
    const raw = localStorage.getItem(profileKeyFor(u));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const writeProfile = (u, patch) => {
  try {
    const cur = readProfile(u) || {};
    localStorage.setItem(profileKeyFor(u), JSON.stringify({ ...cur, ...patch }));
  } catch {}
};

// migrate old global watchlist into the new per-user key once
const migrateWatchlistToUser = (u) => {
  try {
    const globalKey = "WATCHLIST_V1";
    const scopedKey = `WATCHLIST_V1__${safeScope(u, "")}`;
    const oldVal = localStorage.getItem(globalKey);
    const already = localStorage.getItem(scopedKey);
    if (oldVal && !already) {
      localStorage.setItem(scopedKey, oldVal);
    }
  } catch {}
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const hydrate = (u) => {
    if (!u) return null;
    const prof = readProfile(u);
    return { ...u, ...prof };
  };

  useEffect(() => {
    (async () => {
      try {
        const u = await api.me();
        setUser(hydrate(u) || null);
      } catch {
        setUser(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const login = async (email, password) => {
    await api.login({ email, password }); // sets token
    const u = (await api.me().catch(() => null)) || { email };
    migrateWatchlistToUser(u);
    setUser(hydrate(u));
    return u;
  };

  const register = async (email, password) => {
    await api.register({ email, password }); // sets token
    const u = (await api.me().catch(() => null)) || { email };
    migrateWatchlistToUser(u);
    setUser(hydrate(u));
    return u;
  };

  const updateProfile = (patch) => {
    if (!user) return;
    writeProfile(user, patch);
    setUser((prev) => ({ ...(prev || {}), ...(patch || {}) }));
  };

  const logout = () => {
    api.clearAuthToken();
    try {
      // ensure "guest" list is always empty after logout
      localStorage.setItem("WATCHLIST_V1__guest", JSON.stringify([]));
    } catch {}
    setUser(null);
  };

  const value = useMemo(
    () => ({ user, ready, login, register, logout, updateProfile }),
    [user, ready]
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
