import { type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "./useAnchoredPopover";

export function TaskActionMenu({
  label,
  disabled = false,
  className = "",
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const { open, setOpen, close, position, trigger, panel, id } =
    useAnchoredPopover(disabled);
  function navigate(event: KeyboardEvent) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing ||
      !(event.target instanceof HTMLButtonElement)
    )
      return;
    const buttons = Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % buttons.length
        : event.key === "ArrowUp"
          ? (index + buttons.length - 1) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  }
  return (
    <div className={`task-action-trigger ${className}`}>
      <button
        ref={trigger}
        type="button"
        className="task-action-button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="19" cy="12" r="1.5" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className="task-action-popover"
            role="group"
            aria-label={label}
            style={position}
            onKeyDown={navigate}
          >
            {typeof children === "function"
              ? children(() => close(true))
              : children}
          </div>,
          document.body,
        )}
    </div>
  );
}
