import { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as api from "../api";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const u = await api.me();
        setUser(u || null);
      } catch {
        setUser(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const login = async (email, password) => {
    await api.login({ email, password });      // sets token
    const u = await api.me().catch(() => null);
    setUser(u || { email });
    return u;
  };

  const register = async (email, password) => {
    await api.register({ email, password });   // sets token
    const u = await api.me().catch(() => null);
    setUser(u || { email });
    return u;
  };

  const logout = () => {
    api.clearAuthToken();
    setUser(null);
  };

  const value = useMemo(() => ({ user, ready, login, register, logout }), [user, ready]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
