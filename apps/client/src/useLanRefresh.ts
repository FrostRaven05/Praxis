import { useEffect, useRef } from "react";

/** Refresh committed snapshots after sync without replacing an open editor's draft. */
export function useLanRefresh<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  blocked = false,
  scope: unknown = null,
) {
  const latest = useRef({ read, apply, blocked });
  latest.current = { read, apply, blocked };
  const pending = useRef(false);
  const sequence = useRef(0);
  const previousScope = useRef(scope);
  if (!Object.is(previousScope.current, scope)) {
    previousScope.current = scope;
    ++sequence.current;
    pending.current = false;
  }
  useEffect(() => {
    let active = true;
    const update = async () => {
      pending.current = true;
      if (latest.current.blocked) return;
      const token = ++sequence.current;
      try {
        const value = await latest.current.read();
        if (active && token === sequence.current && !latest.current.blocked) {
          latest.current.apply(value);
          pending.current = false;
        }
      } catch {
        // Preserve the last usable snapshot. The next sync retries this read.
      }
    };
    window.addEventListener("praxis-lan-sync", update);
    const timer = setInterval(() => {
      if (pending.current && !latest.current.blocked) void update();
    }, 1000);
    return () => {
      active = false;
      ++sequence.current;
      clearInterval(timer);
      window.removeEventListener("praxis-lan-sync", update);
    };
  }, []);
}
