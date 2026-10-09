import { expect, it, vi } from "vitest";
import { ContentCommands, type ContentCommand } from "./content";
it("reuses the same operation after an unknown response, but assigns a new one to the next user intent", async () => {
  const sent: ContentCommand[] = [];
  let fail = true;
  const client = new ContentCommands(async (c) => {
    sent.push(c);
    if (fail) {
      fail = false;
      throw new Error("response lost");
    }
  });
  const action = {
    type: "capture" as const,
    id: crypto.randomUUID(),
    rawText: "保留原文",
  };
  await expect(client.save(action)).rejects.toThrow("response lost");
  await client.save(action);
  expect(sent[0]).toEqual(sent[1]);
  await client.save({ ...action, id: crypto.randomUUID() });
  expect(sent[2]!.operationId).not.toBe(sent[0]!.operationId);
});
it("blocks concurrent duplicate submissions", async () => {
  let finish!: () => void;
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const client = new ContentCommands(send);
  const action = {
    type: "capture" as const,
    id: crypto.randomUUID(),
    rawText: "原文",
  };
  const first = client.save(action);
  await expect(client.save(action)).rejects.toThrow("正在保存");
  finish();
  await first;
  expect(send).toHaveBeenCalledTimes(1);
});
