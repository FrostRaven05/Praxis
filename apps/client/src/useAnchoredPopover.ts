import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

export function useAnchoredPopover(
  disabled: boolean,
  focusSelector = "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 40 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = panel.current.offsetWidth,
        height = panel.current.offsetHeight;
      setPosition({
        left: Math.max(
          12,
          Math.min(anchor.right - width, innerWidth - width - 12),
        ),
        top: Math.max(
          40,
          anchor.bottom + height + 12 <= innerHeight
            ? anchor.bottom + 6
            : anchor.top - height - 6,
        ),
      });
    };
    place();
    panel.current?.querySelector<HTMLElement>(focusSelector)?.focus();
    const outside = (event: Event) => {
      // A menu must stay open for its modal; a picker inside that modal can dismiss normally.
      if (
        document.querySelector("dialog[open]") &&
        !panel.current?.closest("dialog[open]")
      )
        return;
      const target = event.target as Node;
      if (
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        (!document.querySelector("dialog[open]") ||
          !!panel.current?.closest("dialog[open]"))
      ) {
        event.preventDefault();
        close(true);
      }
    };
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, close, focusSelector]);
  return { open, setOpen, close, trigger, panel, id, position };
}
