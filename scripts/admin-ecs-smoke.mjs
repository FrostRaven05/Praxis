import { chromium } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reads the owner's ignored local handoff file; never writes secrets into evidence.
const base =
  process.env.PRAXIS_ADMIN_BASE_URL ?? "https://todo.frostraven05.com";
const credential = await readFile(
  new URL("../.tools/admin-login.txt", import.meta.url),
  "utf8",
);
const token = credential.match(/管理密钥：([^\r\n]+)/)?.[1]?.trim();
assert.ok(token, "Administrator credential file is missing its key");
const evidence = pathToFileURL(
  resolve(process.env.PRAXIS_ADMIN_EVIDENCE_DIR ?? "docs/evidence/admin-ecs") +
    "/",
);
await mkdir(evidence, { recursive: true });
const checks = {};
const healthResponse = await fetch(`${base}/health`);
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
checks.publicHttpsWithCertificateValidation = health.status === "ok";
assert.equal((await fetch(`${base}/admin`)).status, 200);
checks.adminPage = true;
for (const asset of ["admin.js", "admin.css"]) {
  const response = await fetch(`${base}/admin/${asset}`);
  assert.equal(response.status, 200);
  const published = Buffer.from(await response.arrayBuffer());
  const local = await readFile(
    new URL(`../apps/api/src/admin-web/${asset}`, import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(published).digest("hex"),
    createHash("sha256").update(local).digest("hex"),
  );
}
checks.adminAssetsMatchRelease = true;
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
  for (const view of ["用户管理", "同步数据", "模型设置", "系统状态"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await page.getByRole("heading", { name: view, exact: true }).waitFor();
    await page.locator("#view-content .panel").first().waitFor();
  }
  checks.allAdminViews = true;
  const modelResponse = await context.request.get(`${base}/admin/api/model`);
  assert.equal(modelResponse.status(), 200);
  const model = await modelResponse.json();
  assert.equal(Object.hasOwn(model, "apiKey"), false);
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByLabel("API 密钥", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("API 密钥", { exact: true }).inputValue(),
    "",
  );
  checks.modelSettingsReadWithoutExposingKey = true;
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
const adminLogin = await fetch(`${base}/admin/api/login`, {
  method: "POST",
  headers: { ...jsonHeaders, "x-praxis-admin": "1" },
  body: JSON.stringify({ token }),
});
assert.equal(adminLogin.status, 200);
const adminCookie = adminLogin.headers.get("set-cookie").split(";", 1)[0];
const adminHeaders = {
  ...jsonHeaders,
  "x-praxis-admin": "1",
  cookie: adminCookie,
};
for (const disabled of [true, false]) {
  const changed = await fetch(
    `${base}/admin/api/users/${account.user.id}/status`,
    {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        disabled,
        reason: "部署验收：仅切换临时测试账号",
      }),
    },
  );
  assert.equal(changed.status, 200);
  assert.equal((await fetch(`${base}/v1/account`, { headers })).status, 401);
}
checks.testUserDisableEnableRevokesPreviousLogin = true;
const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ email, password, deviceId }),
});
assert.equal(login.status, 200);
const loginSession = await login.json();
const sessionHeaders = { authorization: `Bearer ${loginSession.token}` };
const revoke = await fetch(
  `${base}/admin/api/users/${account.user.id}/revoke`,
  {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ deviceId, reason: "部署验收：仅撤销临时测试设备" }),
  },
);
assert.equal(revoke.status, 200);
assert.equal(
  (await fetch(`${base}/v1/account`, { headers: sessionHeaders })).status,
  401,
);
checks.testDeviceSessionRevocation = true;
const relogin = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ email, password, deviceId }),
});
assert.equal(relogin.status, 200);
const restored = await relogin.json();
sessionHeaders.authorization = `Bearer ${restored.token}`;
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
// Delete only the freshly registered, uniquely identified acceptance fixture.
assert.match(email, /^admin-deploy-smoke-[a-f0-9-]{36}@example\.invalid$/);
const activeTokens = [];
for (const activeDevice of [deviceId, randomUUID()]) {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email, password, deviceId: activeDevice }),
  });
  assert.equal(response.status, 200);
  activeTokens.push((await response.json()).token);
}
const deleteUrl = `${base}/admin/api/users/${account.user.id}`;
assert.equal(
  (
    await fetch(deleteUrl, {
      method: "DELETE",
      headers: {
        ...jsonHeaders,
        "x-praxis-admin": "1",
        authorization: `Bearer ${activeTokens[0]}`,
      },
      body: JSON.stringify({ email, reason: "部署验收：仅删除临时测试账号" }),
    })
  ).status,
  401,
);
assert.equal(
  (
    await fetch(deleteUrl, {
      method: "DELETE",
      headers: adminHeaders,
      body: JSON.stringify({
        email: "wrong@example.invalid",
        reason: "部署验收：邮箱校验",
      }),
    })
  ).status,
  400,
);
assert.equal((await fetch(deleteUrl, { headers: adminHeaders })).status, 200);
checks.deleteRequiresAdminAndMatchingEmail = true;
const deletionBrowser = await chromium.launch({
  headless: true,
  channel: "msedge",
});
try {
  const context = await deletionBrowser.newContext({
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
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索用户" }).fill(email);
  await page.getByText("共 1 条记录 · 每页 12 条", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  assert.equal(
    await page.locator("#detail-dialog .user-email").textContent(),
    email,
  );
  await page.getByRole("button", { name: "删除用户", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal((await context.request.get(deleteUrl)).status(), 200);
  checks.browserDeleteCancelKeepsUser = true;
  await page.getByRole("button", { name: "删除用户", exact: true }).click();
  await page
    .getByLabel("输入用户邮箱以确认", { exact: true })
    .fill("wrong@example.invalid");
  await page
    .getByLabel("操作原因", { exact: false })
    .fill("部署验收：仅删除临时测试账号及其测试数据");
  await page.getByRole("button", { name: "确认删除用户", exact: true }).click();
  await page
    .getByText("邮箱与所选用户不一致，请重新输入。", { exact: true })
    .waitFor();
  checks.browserDeleteWrongEmailRejected = true;
  await page.getByLabel("输入用户邮箱以确认", { exact: true }).fill(email);
  await page.screenshot({
    path: fileURLToPath(new URL("delete-confirm.png", evidence)),
    fullPage: true,
  });
  const deletionResponse = page.waitForResponse(
    (response) =>
      response.url() === deleteUrl && response.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "确认删除用户", exact: true }).click();
  assert.equal((await deletionResponse).status(), 204);
  await page.locator("#detail-dialog").waitFor({ state: "hidden" });
  await page.getByText("未找到匹配用户", { exact: true }).waitFor();
  await page.screenshot({
    path: fileURLToPath(new URL("delete-complete.png", evidence)),
    fullPage: true,
  });
  checks.browserDeleteRemovesUserAndClosesDetail = true;
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page
    .getByRole("heading", { name: "登录管理控制台", exact: true })
    .waitFor();
} finally {
  await deletionBrowser.close();
}
for (const revokedToken of activeTokens) {
  for (const path of ["/v1/account", "/v1/entities/snapshot"]) {
    assert.equal(
      (
        await fetch(`${base}${path}`, {
          headers: { authorization: `Bearer ${revokedToken}` },
        })
      ).status,
      401,
    );
  }
}
checks.deletedUserAllDevicesAndSyncRejected = true;
assert.equal(
  (
    await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email, password, deviceId }),
    })
  ).status,
  401,
);
assert.equal((await fetch(deleteUrl, { headers: adminHeaders })).status, 404);
assert.equal(
  (
    await fetch(deleteUrl, {
      method: "DELETE",
      headers: adminHeaders,
      body: JSON.stringify({ email, reason: "部署验收：重复删除校验" }),
    })
  ).status,
  404,
);
checks.deletedUserCannotReloginOrBeDeletedTwice = true;
const audit = await fetch(`${base}/admin/api/audit`, { headers: adminHeaders });
assert.equal(audit.status, 200);
assert.ok(
  (await audit.json()).entries.some(
    (entry) =>
      entry.action === "delete_user" && entry.targetId === account.user.id,
  ),
);
checks.userDeletionAudited = true;
assert.deepEqual(browserErrors, []);
assert.equal(
  (
    await fetch(`${base}/admin/api/logout`, {
      method: "POST",
      headers: { cookie: adminCookie, "x-praxis-admin": "1" },
    })
  ).status,
  204,
);
await writeFile(
  new URL("verification.json", evidence),
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      baseUrl: base,
      checks,
      browserErrors,
      testAccountCleanup:
        "deleted through production admin UI; pending read-only database verification",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    verified: Object.keys(checks).length,
    baseUrl: base,
    testAccountCleanup: "deleted through production admin UI",
  }),
);
