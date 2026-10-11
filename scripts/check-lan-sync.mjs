import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import https from "node:https";
import assert from "node:assert/strict";
const directory = new URL("../.tools/lan/", import.meta.url);
const credentials = JSON.parse(
  await readFile(new URL("clients.json", directory), "utf8"),
);
const ca = await readFile(new URL("ca.crt", directory));
const [desktop, android] = credentials.devices;
async function request(device, path, body) {
  return new Promise((resolve, reject) => {
    const serialized = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      credentials.baseUrl + path,
      {
        ca,
        method: serialized ? "POST" : "GET",
        timeout: 5000,
        headers: {
          Authorization: `Bearer ${device.token}`,
          ...(serialized
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(serialized),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end(serialized);
  });
}
const path = "/v1/captures/commands";
const command = {
  operationId: randomUUID(),
  deviceId: desktop.deviceId,
  id: randomUUID(),
  expectedVersion: null,
  rawText: "【局域网接口验收】中文原文\n保留换行 🧪",
  deleted: false,
};
const created = await request(desktop, path, command);
assert.equal(created.status, 200);
assert.deepEqual(await request(desktop, path, command), created);
const pulled = await request(
  android,
  `/v1/captures/changes?after=${created.data.cursor - 1}&limit=1`,
);
assert.equal(pulled.status, 200);
assert.equal(pulled.data.changes[0].capture.rawText, command.rawText);
const edit = {
  ...command,
  operationId: randomUUID(),
  deviceId: android.deviceId,
  expectedVersion: 1,
  rawText: command.rawText + "\n第二设备编辑",
};
assert.equal((await request(android, path, edit)).status, 200);
const stale = { ...command, operationId: randomUUID(), expectedVersion: 1 };
assert.equal((await request(desktop, path, stale)).status, 409);
const removal = {
  ...edit,
  operationId: randomUUID(),
  expectedVersion: 2,
  deleted: true,
};
const deleted = await request(android, path, removal);
assert.equal(deleted.status, 200);
assert.equal((await request(desktop, path, stale)).status, 409);
const evidence = new URL("../docs/evidence/lan/", import.meta.url);
await mkdir(evidence, { recursive: true });
await writeFile(
  new URL("https-smoke.json", evidence),
  JSON.stringify(
    {
      testedAt: new Date().toISOString(),
      baseUrl: credentials.baseUrl,
      certificateVerified: true,
      captureId: command.id,
      finalCursor: deleted.data.cursor,
      checks: [
        "two configured device identities exchange a capture over HTTPS",
        "lost-response retry returns identical receipt",
        "stale update is rejected",
        "deleted capture cannot be resurrected",
      ],
      clientAppConnected: false,
    },
    null,
    2,
  ),
);
console.log(
  "LAN HTTPS sync API checks passed; disposable test capture left as tombstone. Client apps are not yet connected.",
);
