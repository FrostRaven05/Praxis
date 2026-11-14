// Reuse the isolated browser/native bridges; never connects to a user's database.
process.env.PRAXIS_UI_SCENARIO = "projects";
process.env.PRAXIS_UI_EVIDENCE = "docs/evidence/p1-02-2026-11-11";
await import("./personal-todo-smoke.mjs");
