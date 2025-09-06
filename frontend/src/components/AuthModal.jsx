import { useState } from "react";
import { useAuth } from "../auth/AuthContext";

export default function AuthModal({ open, onClose }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState("login"); // 'login' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password);
      onClose?.();
    } catch (e2) {
      setErr(e2?.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div className="card" style={card} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{mode === "login" ? "Sign in" : "Create account"}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={submit} style={{ marginTop: 10 }}>
          <input
            type="email"
            placeholder="email@domain.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: "100%", marginBottom: 8 }}
          />
          <input
            type="password"
            placeholder="Password (min 6 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            style={{ width: "100%", marginBottom: 10 }}
          />
          {err && <div className="muted" style={{ color: "#ff6b6b", marginBottom: 8 }}>{err}</div>}
          <button className="btn" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Please wait…" : (mode === "login" ? "Sign in" : "Create account")}
          </button>
        </form>

        <div className="muted" style={{ textAlign: "center", marginTop: 10 }}>
          {mode === "login" ? (
            <>No account? <button className="ticker-link" onClick={() => setMode("signup")}>Sign up</button></>
          ) : (
            <>Have an account? <button className="ticker-link" onClick={() => setMode("login")}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}

const backdrop = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000, padding: 16,
};
const card = { width: "min(94vw, 420px)", padding: 16 };
