// Real React views, isolated native/Capacitor doubles and synthetic records only.
process.env.PRAXIS_UI_SCENARIO = "inline";
process.env.PRAXIS_UI_EVIDENCE = "docs/evidence/p1-03-2026-11-11";
await import("./personal-todo-smoke.mjs");
