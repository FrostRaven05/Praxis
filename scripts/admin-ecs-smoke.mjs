import { chromium } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

// Reads the owner's ignored local handoff file; never writes secrets into evidence.
const base = "https://8.152.219.210";
const credential = await readFile(
  new URL("../.tools/admin-login.txt", import.meta.url),
  "utf8",
);
const token = credential.match(/管理密钥：([a-f0-9]{64})/)?.[1];
assert.ok(token, "Administrator credential file is missing its key");
const evidence = new URL("../docs/evidence/admin-ecs/", import.meta.url);
await mkdir(evidence, { recursive: true });
const checks = {};
const healthResponse = await fetch(`${base}/health`);
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
checks.publicHttpsWithCertificateValidation = health.status === "ok";
assert.equal((await fetch(`${base}/admin`)).status, 200);
checks.adminPage = true;
assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401);
checks.unauthenticatedAdminRejected = true;
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const browserErrors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${base}/admin`);
  await page.getByLabel("管理密钥", { exact: true }).fill(token);
  await page.getByRole("button", { name: "进入控制台" }).click();
  await page
    .getByRole("heading", { name: "最近注册用户", exact: true })
    .waitFor();
  checks.adminBrowserLogin = true;
  const cookie = (await context.cookies()).find(
    (item) => item.name === "praxis_admin",
  );
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Strict");
  checks.secureAdminCookie = true;
  for (const view of ["用户管理", "同步数据", "操作日志", "系统状态"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await page.getByRole("heading", { name: view, exact: true }).waitFor();
    await page.locator("#view-content .panel").first().waitFor();
  }
  checks.allAdminViews = true;
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page
    .getByRole("heading", { name: "登录管理控制台", exact: true })
    .waitFor();
  assert.equal(
    (await context.request.get(`${base}/admin/api/session`)).status(),
    401,
  );
  checks.adminLogoutRevokesSession = true;
  assert.deepEqual(browserErrors, []);
  checks.noBrowserErrors = true;
} finally {
  await browser.close();
}

const email = `admin-deploy-smoke-${randomUUID()}@example.invalid`;
const password = randomBytes(24).toString("hex"),
  deviceId = randomUUID();
const jsonHeaders = { "Content-Type": "application/json" };
const registration = await fetch(`${base}/auth/register`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({
    email,
    password,
    deviceId,
    displayName: "部署验收临时账号",
  }),
});
assert.equal(registration.status, 201);
const account = await registration.json();
// This marker allows an exact, owner-scoped cleanup even if a later assertion fails.
await writeFile(
  new URL("../.tools/admin-deploy-test-account.json", import.meta.url),
  JSON.stringify({ id: account.user.id, email }),
);
const headers = { ...jsonHeaders, authorization: `Bearer ${account.token}` };
assert.equal((await fetch(`${base}/admin/api/users`, { headers })).status, 401);
checks.normalUserCannotAccessAdmin = true;
const id = randomUUID();
const sync = await fetch(
  `${base}/v1/entities/commands?generation=${health.generation}`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: randomUUID(),
      deviceId,
      changes: [
        {
          id,
          kind: "capture",
          expectedVersion: null,
          data: { rawText: "管理后台部署验收临时数据" },
          deleted: false,
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  },
);
assert.equal(sync.status, 200);
const snapshot = await fetch(`${base}/v1/entities/snapshot`, { headers });
assert.equal(snapshot.status, 200);
assert.ok((await snapshot.json()).entities.some((entity) => entity.id === id));
checks.registrationAndEntitySync = true;
const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ email, password, deviceId }),
});
assert.equal(login.status, 200);
const loginSession = await login.json();
const sessionHeaders = { authorization: `Bearer ${loginSession.token}` };
assert.equal(
  (
    await fetch(`${base}/v1/account/logout`, {
      method: "POST",
      headers: sessionHeaders,
    })
  ).status,
  204,
);
assert.equal(
  (await fetch(`${base}/v1/account`, { headers: sessionHeaders })).status,
  401,
);
checks.userLoginAndLogout = true;
await writeFile(
  new URL("verification.json", evidence),
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      baseUrl: base,
      checks,
      browserErrors,
      testAccountCleanup: "pending",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    verified: Object.keys(checks).length,
    baseUrl: base,
    testAccountCleanup: "pending",
  }),
);
