export function TaskPanelIcon({
  name,
}: {
  name:
    | "clock"
    | "work"
    | "check"
    | "box"
    | "folder"
    | "criteria"
    | "close"
    | "inbox"
    | "sun"
    | "branch";
}) {
  return (
    <svg
      className="task-panel-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "clock" ? (
        <>
          <circle cx="12" cy="13" r="8" />
          <path d="M12 9v4l3 2M5 3 2 6M19 3l3 3" />
        </>
      ) : name === "work" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6M12 17h.01" />
        </>
      ) : name === "box" ? (
        <rect x="4" y="4" width="16" height="16" rx="3" />
      ) : name === "check" ? (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="m8 12 3 3 5-6" />
        </>
      ) : name === "folder" ? (
        <path d="M3 8V5h6l2 3h10v12H3Z" />
      ) : name === "criteria" ? (
        <path d="m3 7 2 2 3-3M11 7h10m-18 9 2 2 3-3M11 16h10" />
      ) : name === "close" ? (
        <path d="m9 5 7 7-7 7" />
      ) : name === "inbox" ? (
        <>
          <path d="M4 4h16v16H4Z" />
          <path d="M4 14h5l1 3h4l1-3h5" />
        </>
      ) : name === "sun" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </>
      ) : (
        <path d="M5 3v13a4 4 0 0 0 4 4h8M5 7h12m0-3 3 3-3 3m0 7 3 3-3 3" />
      )}
    </svg>
  );
}
