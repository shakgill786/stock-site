import { useEffect, useRef, useState } from "react";

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export default function useLocalStorage(key, initialValue) {
  const k = String(key);
  const [state, setState] = useState(() => readLS(k, initialValue));
  const prevKeyRef = useRef(k);

  // When the key changes (e.g., user switches), load from the new key
  useEffect(() => {
    const nextK = String(key);
    if (prevKeyRef.current !== nextK) {
      prevKeyRef.current = nextK;
      setState(readLS(nextK, initialValue));
    }
  }, [key, initialValue]);

  // Persist to the *current* key
  useEffect(() => {
    try {
      localStorage.setItem(k, JSON.stringify(state));
    } catch {}
  }, [k, state]);

  // Cross-tab sync and external changes to this key
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === k) setState(readLS(k, initialValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [k, initialValue]);

  return [state, setState];
}
