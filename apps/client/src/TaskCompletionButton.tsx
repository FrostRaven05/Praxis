export function TaskCompletionButton({
  title,
  completed,
  busy = false,
  disabled = false,
  className = "",
  onToggle,
}: {
  title: string;
  completed: boolean;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`completion-toggle${className ? ` ${className}` : ""}`}
      aria-pressed={completed}
      aria-busy={busy}
      aria-label={completed ? "撤销完成" : "标为完成"}
      title={title}
      disabled={disabled || busy}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {busy ? (
          <path className="completion-spinner" d="M12 3a9 9 0 1 1-9 9" />
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            {completed && <path className="completion-check" d="m7.5 12 3 3 6-6" />}
          </>
        )}
      </svg>
    </button>
  );
}
