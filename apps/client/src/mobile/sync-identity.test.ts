import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { scheduleId, workspaceSettingsId } from "./sync-identity";
it("matches UUIDv5 URL namespace identities used by Rust for both schedule kinds", () => {
  const owner = "12345678-1234-4234-9234-123456789abc",
    date = "2026-10-11";
  for (const kind of ["task", "habit_check"] as const) {
    const name =
      kind === "task"
        ? `praxis:occurrence:${owner}:${date}`
        : `praxis:habit_check:${JSON.stringify([owner, date])}`;
    const b = createHash("sha1")
      .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
      .update(name)
      .digest()
      .subarray(0, 16);
    b[6] = (b[6]! & 15) | 80;
    b[8] = (b[8]! & 63) | 128;
    const h = b.toString("hex"),
      expected = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    expect(scheduleId(kind, owner, date)).toBe(expected);
  }
});
it("uses the same stable workspace-settings identity as native UUIDv5", () => {
  const b = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update("praxis:workspace_settings:{}")
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 80;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString("hex");
  expect(workspaceSettingsId()).toBe(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
  );
});
