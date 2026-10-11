export type MobileIconName =
  | "tasks"
  | "calendar"
  | "focus"
  | "stats"
  | "settings"
  | "theme"
  | "history"
  | "zone"
  | "play";
export function MobileNavIcon({ name }: { name: MobileIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "tasks" ? (
        <path d="M4 6h2m4 0h10M4 12h2m4 0h10M4 18h2m4 0h10" />
      ) : name === "calendar" ? (
        <>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M7 3v4m10-4v4M3 10h18M7 14h2m6 0h2m-10 4h2m6 0h2" />
        </>
      ) : name === "focus" ? (
        <>
          <circle cx="12" cy="14" r="7" />
          <path d="M10 2h4m-2 0v5m5 1 2-2M12 10v4l2 2" />
        </>
      ) : name === "stats" ? (
        <>
          <path d="M4 20V4m0 16h17M7 14l4-4 4 2 5-7" />
          <path d="M17 5h3v3" />
        </>
      ) : name === "settings" ? (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </>
      ) : name === "theme" ? (
        <>
          <path d="M20 13a9 9 0 1 0-9 8c4 0 1-5 4-5h2a3 3 0 0 0 3-3Z" />
          <path d="M7 9h.01M11 6h.01M16 8h.01M6 14h.01" />
        </>
      ) : name === "zone" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <ellipse cx="12" cy="12" rx="4" ry="9" />
          <path d="M3 12h18" />
        </>
      ) : name === "history" ? (
        <>
          <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7" />
          <path d="M12 7v5l3 2" />
        </>
      ) : (
        <path d="m9 5 11 7-11 7Z" />
      )}
    </svg>
  );
}
