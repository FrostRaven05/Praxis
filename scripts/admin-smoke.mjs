import { chromium } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "../apps/api/dist/server.js";

// Own temporary database, credentials and server: never connects to production.
const directory = await mkdtemp(join(tmpdir(), "praxis-admin-browser-"));
const evidence = fileURLToPath(
  new URL("../docs/evidence/admin/", import.meta.url),
);
await mkdir(evidence, { recursive: true });
const token = randomBytes(32).toString("hex");
const server = createServer({
  databasePath: join(directory, "api.db"),
  devices: [],
  adminTokenHash: createHash("sha256").update(token).digest("hex"),
});
let browser;
const errors = [];
const checks = [];
const check = (label) => checks.push(label);
try {
  await server.listen({ host: "127.0.0.1", port: 0 });
  const base = server.listeningOrigin;
  const edgeInstalled =
    process.platform === "win32" &&
    existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
  browser = await chromium.launch({
    headless: true,
    ...(edgeInstalled ? { channel: "msedge" } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1060 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401"))
      errors.push(message.text());
  });
  await page.goto(`${base}/admin`);
  await page.getByLabel("管理密钥", { exact: true }).fill(token);
  await page.getByRole("button", { name: "进入控制台" }).click();
  await page.getByText("还没有注册用户", { exact: true }).waitFor();
  check("管理员登录与真实空状态");
  await page.screenshot({
    path: join(evidence, "overview-empty.png"),
    fullPage: true,
  });

  let member;
  const names = [
    "陈思远",
    "林小满",
    "周予安",
    "许知行",
    "苏清和",
    "沈一诺",
    "顾言",
    "唐知夏",
    "陆星禾",
    "宋以宁",
    "程亦然",
    "叶书宁",
    "林澈",
    "赵知微",
  ];
  for (const [index, displayName] of names.entries()) {
    const response = await server.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: `member${String(index + 1).padStart(2, "0")}@example.test`,
        password: randomBytes(24).toString("hex"),
        displayName,
        deviceId: randomUUID(),
      },
    });
    assert.equal(response.statusCode, 201);
    if (index === 0) member = response.json();
  }
  const generation = (await server.inject({ url: "/health" })).json()
    .generation;
  const sync = await server.inject({
    method: "POST",
    url: `/v1/entities/commands?generation=${generation}`,
    headers: { authorization: `Bearer ${member.token}` },
    payload: {
      operationId: randomUUID(),
      deviceId: member.deviceId,
      changes: Array.from({ length: 7 }, (_, index) => ({
        id: randomUUID(),
        kind: "capture",
        expectedVersion: null,
        data: { rawText: `本地验收收集内容 ${index + 1}` },
        deleted: false,
        createdAt: new Date().toISOString(),
      })),
    },
  });
  assert.equal(sync.statusCode, 200);
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await page.getByText("当前服务共 14 个注册账号", { exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "overview.png"),
    fullPage: true,
  });
  check("数据概览展示真实注册用户与已同步实体");

  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.getByText("共 14 条记录 · 每页 12 条", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("2 / 2", { exact: true }).waitFor();
  check("用户分页");
  await page.getByRole("textbox", { name: "搜索用户" }).fill("member01");
  await page.getByText("共 1 条记录 · 每页 12 条", { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前页", exact: true }).click();
  const download = await downloadPromise;
  const exportPath = join(directory, "users.csv");
  await download.saveAs(exportPath);
  const exported = await readFile(exportPath, "utf8");
  assert.ok(exported.includes("member01@example.test"));
  assert.ok(!exported.includes("member02@example.test"));
  await page.getByRole("button", { name: "查看详情" }).click();
  await page.getByText("有效登录设备 · 1 台", { exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "user-detail.png"),
    fullPage: true,
  });
  check("用户搜索、导出与真实设备详情");
  await page.getByRole("button", { name: "禁用账号", exact: true }).click();
  await page
    .getByLabel("操作原因", { exact: false })
    .fill("本地浏览器验收：暂时禁用测试账号");
  await page.getByRole("button", { name: "确认禁用账号", exact: true }).click();
  await page.getByText("有效登录设备 · 0 台", { exact: true }).waitFor();
  assert.equal(
    (
      await server.inject({
        url: "/v1/account",
        headers: { authorization: `Bearer ${member.token}` },
      })
    ).statusCode,
    401,
  );
  await page.getByRole("button", { name: "启用账号", exact: true }).click();
  await page
    .getByLabel("操作原因", { exact: false })
    .fill("本地浏览器验收：恢复测试账号");
  await page.getByRole("button", { name: "确认启用账号", exact: true }).click();
  await page.getByRole("button", { name: "禁用账号", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  check("禁用与启用确认、撤销登录与旧会话失效");
  await page
    .getByRole("combobox", { name: "账号状态" })
    .selectOption("disabled");
  await page.getByText("未找到匹配用户", { exact: true }).waitFor();
  check("账号状态筛选");

  for (const [label, heading] of [
    ["同步数据", "同步数据"],
    ["操作日志", "操作日志"],
    ["系统状态", "系统状态"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    if (label === "同步数据")
      await page
        .getByRole("heading", { name: "同步累计", exact: true })
        .waitFor();
    if (label === "操作日志")
      await page
        .getByText("本地浏览器验收：恢复测试账号", { exact: true })
        .waitFor();
    if (label === "系统状态")
      await page.getByText("Node.js", { exact: true }).waitFor();
    check(`${label}页面`);
  }
  await page.getByRole("button", { name: "数据概览", exact: true }).click();
  await page.getByText("当前服务共 14 个注册账号", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByText("当前服务共 14 个注册账号", { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "手机布局不能出现页面横向滚动",
  );
  await page.screenshot({
    path: join(evidence, "overview-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索用户" }).waitFor();
  check("390px 手机布局与折叠导航");
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page
    .getByRole("heading", { name: "登录管理控制台", exact: true })
    .waitFor();
  check("退出登录");
  assert.deepEqual(errors, []);
  await rm(join(evidence, "failed.png"), { force: true });
  await writeFile(
    join(evidence, "verification.json"),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        environment:
          "isolated local SQLite; test users only; no production connection",
        checks,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, evidence, browserErrors: errors }),
  );
} catch (error) {
  console.error(error);
  if (browser)
    await browser
      .contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: join(evidence, "failed.png"), fullPage: true });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
