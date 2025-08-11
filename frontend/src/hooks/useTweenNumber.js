import { useEffect, useRef, useState } from "react";

export default function useTweenNumber(target, { duration = 400 } = {}) {
  const [value, setValue] = useState(target ?? 0);
  const raf = useRef(null);
  const startRef = useRef(0);
  const fromRef = useRef(0);
  const toRef = useRef(0);

  useEffect(() => {
    if (typeof target !== "number" || isNaN(target)) return;
    cancelAnimationFrame(raf.current);
    fromRef.current = value;
    toRef.current = target;
    startRef.current = performance.now();

    const tick = (t) => {
      const p = Math.min(1, (t - startRef.current) / duration);
      const v = fromRef.current + (toRef.current - fromRef.current) * p;
      setValue(v);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return value;
}
