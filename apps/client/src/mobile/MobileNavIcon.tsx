export type MobileIconName =
  | "todos"
  | "projects"
  | "tasks"
  | "sun"
  | "calendar"
  | "focus"
  | "stats"
  | "settings"
  | "theme"
  | "history"
  | "zone"
  | "play"
  | "pause"
  | "more"
  | "sparkle"
  | "back"
  | "update"
  | "trash";

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
      {name === "sun" ? (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </>
      ) : name === "tasks" ? (
        <path d="M4 6h2m4 0h10M4 12h2m4 0h10M4 18h2m4 0h10" />
      ) : name === "todos" ? (
        <>
          <path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
          <path d="M14 3.5V8h4.5M8 12.5h8M8 16.5h5" />
        </>
      ) : name === "projects" ? (
        <path d="M3 7V5h6l2 2h10v13H3V7Z" />
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
      ) : name === "more" ? (
        <>
          <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
        </>
      ) : name === "sparkle" ? (
        <path d="m12 3 1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9Z" />
      ) : name === "back" ? (
        <path d="m15 18-6-6 6-6" />
      ) : name === "pause" ? (
        <>
          <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
          <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
        </>
      ) : name === "update" ? (
        <>
          <path d="M12 3v11m0 0-4-4m4 4 4-4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </>
      ) : name === "trash" ? (
        <>
          <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
        </>
      ) : (
        <path d="m9 5 11 7-11 7Z" />
      )}
    </svg>
  );
}
