import { cpSync } from "node:fs";
cpSync(
  new URL("../src/admin-web/", import.meta.url),
  new URL("../dist/admin-web/", import.meta.url),
  { recursive: true },
);
