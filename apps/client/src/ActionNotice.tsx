import "./action-notice.css";

export function ActionNotice({
  message,
  actionLabel,
  onAction,
  onDismiss,
  disabled = false,
}: {
  message: string;
  actionLabel?: string | undefined;
  onAction?: (() => void) | undefined;
  onDismiss: () => void;
  disabled?: boolean;
}) {
  if (!message) return null;
  return (
    <div className="action-notice" role="status" aria-live="polite">
      <span>{message}</span>
      {onAction && (
        <button type="button" disabled={disabled} onClick={onAction}>
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        className="action-notice-dismiss"
        aria-label="关闭操作提示"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
