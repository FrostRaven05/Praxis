import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";

// Config is local-only: tokens are hashed; TLS private key never enters a client build.
const configPath = process.env.PRAXIS_LAN_CONFIG
  ? resolve(process.env.PRAXIS_LAN_CONFIG)
  : fileURLToPath(new URL("../../../.tools/lan/server.json", import.meta.url));
const root = dirname(configPath);
try {
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object") throw new Error("invalid_config");
  const c = config as Record<string, unknown>;
  if (
    typeof c.host !== "string" ||
    !Number.isInteger(c.port) ||
    Number(c.port) < 1024 ||
    Number(c.port) > 65535 ||
    typeof c.databasePath !== "string" ||
    typeof c.keyPath !== "string" ||
    typeof c.certPath !== "string" ||
    !Array.isArray(c.devices)
  )
    throw new Error("invalid_config");
  const devices = c.devices.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid_device");
    const d = entry as Record<string, unknown>;
    if (
      typeof d.ownerId !== "string" ||
      typeof d.deviceId !== "string" ||
      typeof d.tokenHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(d.tokenHash)
    )
      throw new Error("invalid_device");
    return { ownerId: d.ownerId, deviceId: d.deviceId, tokenHash: d.tokenHash };
  });
  const app = createServer({
    databasePath: resolve(root, c.databasePath),
    devices,
    https: {
      key: readFileSync(resolve(root, c.keyPath)),
      cert: readFileSync(resolve(root, c.certPath)),
    },
  });
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void app.close().then(() => process.exit(0));
    });
  }
  await app.listen({ host: c.host, port: Number(c.port) });
  console.log(`Praxis LAN HTTPS listening on ${c.host}:${c.port}`);
} catch {
  // Do not print config, credentials, request bodies, or DB paths on failure.
  console.error(
    "Praxis LAN failed to start. Check local configuration, TLS files and port availability.",
  );
  process.exitCode = 1;
}
