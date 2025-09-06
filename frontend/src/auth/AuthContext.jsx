import { createContext, useContext, useEffect, useState } from "react";
import { authLogin, authRegister, authMe } from "../api";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem("AUTH_TOKEN") || "");
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(!!token);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    if (!token) { setUser(null); setAuthLoading(false); return; }
    (async () => {
      try {
        setAuthLoading(true);
        const me = await authMe();
        setUser(me);
        setAuthError("");
      } catch (e) {
        setUser(null);
        setToken("");
        localStorage.removeItem("AUTH_TOKEN");
        setAuthError(e?.message || "Auth failed");
      } finally {
        setAuthLoading(false);
      }
    })();
  }, [token]);

  const login = async (email, password) => {
    setAuthError("");
    const res = await authLogin({ email, password });
    localStorage.setItem("AUTH_TOKEN", res.access_token);
    setToken(res.access_token);
    return res;
  };

  const register = async (email, password) => {
    setAuthError("");
    const res = await authRegister({ email, password });
    localStorage.setItem("AUTH_TOKEN", res.access_token);
    setToken(res.access_token);
    return res;
  };

  const logout = () => {
    localStorage.removeItem("AUTH_TOKEN");
    setToken("");
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ token, user, authLoading, authError, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}
