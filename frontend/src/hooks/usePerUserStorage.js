import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";

/**
 * Per-user localStorage state.
 * - Keys are namespaced like `${baseKey}__${userIdOrEmail}`
 * - Rehydrates automatically when the user changes (login/logout/switch)
 * - Syncs across tabs/windows via the 'storage' event
 *
 * @example
 * const [items, setItems, meta] = usePerUserStorage("WATCHLIST_V1", []);
 * meta.key   -> actual storage key in use
 * meta.scope -> current user scope id (id/email/guest)
 */
export default function usePerUserStorage(baseKey, initialValue) {
  const { user } = useAuth();

  // stable scope id for the user
  const scope = useMemo(
    () => String((user?.id || user?.email || "guest")).toLowerCase(),
    [user?.id, user?.email]
  );

  // actual storage key for this scope
  const storageKey = useMemo(() => `${baseKey}__${scope}`, [baseKey, scope]);

  // utils
  const read = useCallback(
    (key) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return clone(initialValue);
        return JSON.parse(raw);
      } catch {
        return clone(initialValue);
      }
    },
    [initialValue]
  );

  const write = useCallback((key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota/security errors
    }
  }, []);

  // state bound to the current storageKey
  const [state, setState] = useState(() => read(storageKey));

  // when the user (scope) changes, rehydrate from the new key
  useEffect(() => {
    setState(read(storageKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // keep in sync with other tabs/windows
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === storageKey) {
        try {
          setState(e.newValue ? JSON.parse(e.newValue) : clone(initialValue));
        } catch {
          setState(clone(initialValue));
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey, initialValue]);

  // setter that always writes to the active key
  const set = useCallback(
    (next) => {
      setState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        write(storageKey, value);
        return value;
      });
    },
    [storageKey, write]
  );

  // expose a little meta for debugging/advanced usage
  const meta = useMemo(() => ({ key: storageKey, scope }), [storageKey, scope]);

  return [state, set, meta];
}

function clone(v) {
  return typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) : v;
}
