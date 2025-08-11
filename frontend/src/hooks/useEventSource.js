import { useEffect, useRef } from "react";

export default function useEventSource(url, { onMessage, enabled = true } = {}) {
  const srcRef = useRef(null);

  useEffect(() => {
    if (!enabled || !url) return;

    const src = new EventSource(url, { withCredentials: false });
    srcRef.value = src;

    src.onmessage = (e) => {
      if (onMessage) {
        try {
          onMessage(JSON.parse(e.data));
        } catch {
          // ignore malformed
        }
      }
    };
    src.onerror = () => {
      // browser auto-reconnects; we could close if needed
    };

    return () => {
      try { src.close(); } catch {}
    };
  }, [url, enabled, onMessage]);
}
