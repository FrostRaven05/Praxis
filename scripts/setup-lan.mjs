import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import {
  randomBytes,
  randomUUID,
  createHash,
  X509Certificate,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { isIPv4 } from "node:net";
import { resolve } from "node:path";

const address = process.argv[2];
if (
  !address ||
  !isIPv4(address) ||
  !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
) {
  throw new Error("Pass the computer private LAN IPv4 address.");
}
const directory = resolve(".tools/lan");
await mkdir(directory, { recursive: true });
const configPath = resolve(directory, "server.json");
let exists = false;
try {
  await access(configPath);
  exists = true;
} catch {
  /* first setup */
}
if (exists) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.host !== address)
    throw new Error(
      "LAN address changed. Existing credentials were preserved; update host and regenerate the server certificate before restarting.",
    );
  console.log(
    "Existing LAN setup retained. No credentials or database replaced.",
  );
  process.exit(0);
}
const openssl =
  process.env.PRAXIS_OPENSSL || "C:/Program Files/Git/usr/bin/openssl.exe";
function ssl(args) {
  execFileSync(openssl, args, {
    cwd: directory,
    stdio: "pipe",
    windowsHide: true,
  });
}
// Refuse to overwrite a partially generated setup; it may already contain credentials.
for (const name of ["ca.key", "server.key", "clients.json"]) {
  try {
    await access(resolve(directory, name));
  } catch {
    continue;
  }
  throw new Error(
    `Partial setup detected (${name}). Preserve and inspect it before retrying.`,
  );
}
ssl([
  "req",
  "-x509",
  "-newkey",
  "rsa:3072",
  "-nodes",
  "-keyout",
  "ca.key",
  "-out",
  "ca.crt",
  "-days",
  "3650",
  "-subj",
  "/CN=Praxis Local Development CA",
  "-addext",
  "basicConstraints=critical,CA:TRUE,pathlen:0",
  "-addext",
  "keyUsage=critical,keyCertSign,cRLSign",
]);
ssl([
  "req",
  "-new",
  "-newkey",
  "rsa:3072",
  "-nodes",
  "-keyout",
  "server.key",
  "-out",
  "server.csr",
  "-subj",
  "/CN=Praxis LAN",
]);
await writeFile(
  resolve(directory, "server.ext"),
  `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${address},IP:127.0.0.1,IP:10.0.2.2,DNS:localhost\n`,
);
ssl([
  "x509",
  "-req",
  "-in",
  "server.csr",
  "-CA",
  "ca.crt",
  "-CAkey",
  "ca.key",
  "-CAcreateserial",
  "-out",
  "server.crt",
  "-days",
  "365",
  "-extfile",
  "server.ext",
]);
const ownerId = randomUUID();
const clients = ["desktop-dev", "android-dev"].map((label) => ({
  label,
  ownerId,
  deviceId: randomUUID(),
  token: randomBytes(32).toString("base64url"),
}));
await writeFile(
  resolve(directory, "clients.json"),
  JSON.stringify(
    { baseUrl: `https://${address}:4318`, devices: clients },
    null,
    2,
  ),
  { mode: 0o600 },
);
await writeFile(
  configPath,
  JSON.stringify(
    {
      host: address,
      port: 4318,
      databasePath: "praxis.sqlite",
      keyPath: "server.key",
      certPath: "server.crt",
      devices: clients.map(({ ownerId, deviceId, token }) => ({
        ownerId,
        deviceId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      })),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const cert = new X509Certificate(await readFile(resolve(directory, "ca.crt")));
await writeFile(
  resolve(directory, "connection.json"),
  JSON.stringify(
    {
      baseUrl: `https://${address}:4318`,
      caFingerprint256: cert.fingerprint256,
      protocolVersion: 1,
    },
    null,
    2,
  ),
);
console.log(
  `LAN setup ready: https://${address}:4318. Device credentials saved locally; not printed.`,
);
