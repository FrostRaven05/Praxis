export function ProjectIcon({
  name,
}: {
  name:
    | "tasks"
    | "gantt"
    | "board"
    | "folder"
    | "plus"
    | "settings"
    | "archive"
    | "arrow"
    | "edit";
}) {
  return (
    <svg
      className="project-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "plus" ? (
        <path d="M12 5v14M5 12h14" />
      ) : name === "settings" ? (
        <>
          <path d="m9 3-.7 2.4-2.4 1L3.7 6 2 9l1.7 1.8v2.4L2 15l1.7 3 2.2-.4 2.4 1L9 21h6l.7-2.4 2.4-1 2.2.4 1.7-3-1.7-1.8v-2.4L22 9l-1.7-3-2.2.4-2.4-1L15 3Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : name === "archive" ? (
        <>
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <path d="M5 8v12h14V8M9 12h6" />
        </>
      ) : name === "arrow" ? (
        <path d="m9 5 7 7-7 7" />
      ) : name === "edit" ? (
        <path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z" />
      ) : name === "folder" ? (
        <path d="M3 8V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
      ) : name === "tasks" ? (
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      ) : name === "gantt" ? (
        <>
          <path d="M4 3v18M8 6h8M12 12h9M8 18h6" />
        </>
      ) : (
        <>
          <rect x="3" y="4" width="5" height="16" rx="1" />
          <rect x="10" y="4" width="5" height="10" rx="1" />
          <rect x="17" y="4" width="4" height="13" rx="1" />
        </>
      )}
    </svg>
  );
}
