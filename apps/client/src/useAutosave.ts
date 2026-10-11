import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Serial writes acknowledge their captured input; newer input stays queued. */
export function useAutosave<Draft>(options: {
  draft: Draft;
  enabled: boolean;
  hasChanges: (draft: Draft) => boolean;
  validate: (draft: Draft) => void;
  persist: (draft: Draft) => Promise<void>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [composing, setComposing] = useState(false);
  const composition = useRef(composing);
  composition.current = composing;
  const immediate = useRef(false);
  const pending = useRef<Draft | null>(null);
  const flight = useRef<Promise<boolean> | null>(null);
  const operations = useRef({
    save: () => Promise.resolve(false),
    flush: () => Promise.resolve(false),
  });
  const dirty = options.hasChanges(options.draft);
  function save(): Promise<boolean> {
    if (flight.current) return flight.current;
    if (!latest.current.enabled || composition.current)
      return Promise.resolve(false);
    if (!pending.current && !latest.current.hasChanges(latest.current.draft))
      return Promise.resolve(true);
    const promise = persist();
    flight.current = promise;
    void promise.then(() => {
      flight.current = null;
    });
    return promise;
  }
  async function persist() {
    immediate.current = false;
    const captured = pending.current ?? latest.current.draft;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      latest.current.validate(captured);
      pending.current = captured;
      await latest.current.persist(captured);
      pending.current = null;
      setSaved(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function flush() {
    do {
      if (!(await operations.current.save())) return false;
    } while (
      pending.current ||
      latest.current.hasChanges(latest.current.draft)
    );
    return true;
  }
  operations.current = { save, flush };
  const key = JSON.stringify(options.draft);
  useEffect(() => {
    if (
      !options.enabled ||
      (!dirty && !pending.current) ||
      busy ||
      error ||
      composing
    )
      return;
    const timer = setTimeout(
      () => void operations.current.save(),
      immediate.current ? 0 : 500,
    );
    return () => clearTimeout(timer);
  }, [options.enabled, dirty, busy, error, composing, key]);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let off: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (
          !flight.current &&
          !pending.current &&
          !latest.current.hasChanges(latest.current.draft)
        )
          return;
        if (!(await operations.current.flush())) e.preventDefault();
      })
      .then((unlisten) => {
        if (active) off = unlisten;
        else unlisten();
      })
      .catch(() => {});
    return () => {
      active = false;
      off?.();
    };
  }, []);
  return {
    busy,
    error,
    dirty,
    pending: !!pending.current,
    status: busy
      ? "正在保存…"
      : error
        ? "保存未完成，修改已保留"
        : dirty
          ? "等待自动保存…"
          : saved
            ? "已自动保存"
            : "自动保存到本机",
    save,
    flush,
    changed: (discrete = false) => {
      immediate.current = discrete;
      setError("");
      setSaved(false);
    },
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: () => setComposing(false),
  };
}
