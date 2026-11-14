// Full React app integration with synthetic native/Capacitor bridges only.
process.env.PRAXIS_UI_SCENARIO = "remaining";
process.env.PRAXIS_UI_EVIDENCE =
  "docs/evidence/remaining-mvp-2026-11-12/browser";
await import("./personal-todo-smoke.mjs");
