// frontend/src/hooks/usePerUserStorage.js
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";

/**
 * Stores values under a key that is namespaced by the current user (email/id).
 * When the user changes (login/logout/switch), the hook automatically
 * reads from the new per-user key and causes a re-render.
 *
 * Example stored keys:
 *  - WATCHLIST_V1__alice@example.com
 *  - WATCHLIST_V1__guest
 */
export default function usePerUserStorage(baseKey, initialValue) {
  const { user } = useAuth?.() || { user: null };
  const uid = (user?.id || user?.email || "").toLowerCase() || "guest";
  const effectiveKey = useMemo(() => `${baseKey}__${uid}`, [baseKey, uid]);

  const read = () => {
    try {
      const raw = localStorage.getItem(effectiveKey);
      return raw != null ? JSON.parse(raw) : initialValue;
    } catch {
      return initialValue;
    }
  };

  const [value, setValue] = useState(read);

  // When the key changes (user switch), re-read
  useEffect(() => {
    setValue(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKey]);

  // Persist on change
  useEffect(() => {
    try { localStorage.setItem(effectiveKey, JSON.stringify(value)); } catch {}
  }, [effectiveKey, value]);

  return [value, setValue, effectiveKey];
}
