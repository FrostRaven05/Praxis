import schema from "../../../apps/desktop/src-tauri/migrations/0001_capture.sql?raw";
// Version 1 contains no triggers or semicolons inside literals; each plugin entry is one statement.
export const initialStatements = schema
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
