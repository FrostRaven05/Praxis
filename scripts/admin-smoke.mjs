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
  release: {
    version: "1.0.1",
    minimumVersion: "0.1.0",
    notes: "Windows 与 Android 安装包",
    publishedAt: "2026-11-16T00:00:00.000Z",
    windows: {
      url: "https://download.example.test/Praxis-setup.exe",
      sha256: "a".repeat(64),
    },
    android: {
      url: "https://download.example.test/Praxis.apk",
      sha256: "b".repeat(64),
    },
  },
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
  assert.equal(
    await page.getByRole("button", { name: "操作日志", exact: true }).count(),
    0,
  );
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
    ["系统状态", "系统状态"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    if (label === "同步数据")
      await page
        .getByRole("heading", { name: "数据分类", exact: true })
        .waitFor();
    if (label === "系统状态")
      await page.getByText("正常运行", { exact: true }).waitFor();
    await page.screenshot({
      path: join(evidence, label === "同步数据" ? "sync.png" : "system.png"),
      fullPage: true,
    });
    check(`${label}页面`);
  }
  await page.getByRole("button", { name: "数据概览", exact: true }).click();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.getByLabel("服务", { exact: true }).selectOption("openai");
  assert.equal(
    await page.getByLabel("接口地址", { exact: true }).inputValue(),
    "https://api.openai.com/v1",
  );
  assert.equal(await page.getByLabel("模型", { exact: true }).inputValue(), "");
  await page.getByLabel("服务", { exact: true }).selectOption("deepseek");
  await page.getByLabel("模型", { exact: true }).fill("admin-browser-smoke");
  await page
    .getByLabel("接口地址", { exact: true })
    .fill("https://model-smoke.example.invalid");
  await page
    .getByLabel("API 密钥", { exact: true })
    .fill(randomBytes(24).toString("hex"));
  await page
    .getByRole("button", { name: "显示 API 密钥", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("API 密钥", { exact: true }).getAttribute("type"),
    "text",
  );
  await page
    .getByRole("button", { name: "隐藏 API 密钥", exact: true })
    .click();
  await page.getByRole("button", { name: "保存模型设置", exact: true }).click();
  await page.getByText("模型设置已保存。", { exact: true }).waitFor();
  await page.reload();
  await page.getByLabel("模型", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("模型", { exact: true }).inputValue(),
    "admin-browser-smoke",
  );
  assert.equal(
    await page.getByLabel("API 密钥", { exact: true }).inputValue(),
    "",
  );
  // Blank key saves keep the existing credential and custom provider values.
  await page.getByLabel("服务", { exact: true }).selectOption("openai");
  assert.equal(
    await page.getByLabel("接口地址", { exact: true }).inputValue(),
    "https://model-smoke.example.invalid",
  );
  assert.equal(
    await page.getByLabel("模型", { exact: true }).inputValue(),
    "admin-browser-smoke",
  );
  await page.getByRole("button", { name: "保存模型设置", exact: true }).click();
  await page.getByText("模型设置已保存。", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "model.png"), fullPage: true });
  check("模型设置保存、刷新保持与密钥不回显（无外部模型请求）");
  await page.getByRole("button", { name: "安装包", exact: true }).click();
  await page
    .getByRole("heading", { name: "Praxis 1.0.1", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "下载安装包", exact: true })
      .getAttribute("href"),
    "https://download.example.test/Praxis-setup.exe",
  );
  assert.equal(
    await page
      .getByRole("link", { name: "下载 APK", exact: true })
      .getAttribute("href"),
    "https://download.example.test/Praxis.apk",
  );
  await page.getByText("SHA-256 校验值", { exact: true }).first().click();
  await page.getByText("a".repeat(64), { exact: true }).waitFor();
  await page.screenshot({
    path: join(evidence, "release.png"),
    fullPage: true,
  });
  check("Windows / Android 安装包下载入口与 SHA-256 校验值");
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
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [label, selector, shot] of [
      ["模型设置", "#model-form", "model"],
      ["同步数据", ".metrics-three", "sync"],
      ["系统状态", ".system-body", "system"],
      ["安装包", ".release-grid", "release"],
    ]) {
      await page.getByRole("button", { name: "展开导航", exact: true }).click();
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.locator(selector).waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${width}px ${label}无横向滚动`,
      );
      await page.screenshot({
        path: join(evidence, `${shot}-${width}.png`),
        fullPage: true,
      });
    }
  }
  check("模型、同步和系统页的 390px / 320px 布局");
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索用户" }).fill("member01");
  await page.getByText("共 1 条记录 · 每页 12 条", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看详情" }).click();
  await page.getByRole("button", { name: "删除用户", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.ok(
    await page
      .getByRole("button", { name: "删除用户", exact: true })
      .isVisible(),
  );
  await page.getByRole("button", { name: "删除用户", exact: true }).click();
  await page
    .getByLabel("输入用户邮箱以确认", { exact: true })
    .fill("wrong@example.test");
  await page
    .getByLabel("操作原因", { exact: false })
    .fill("本地验收：删除测试用户");
  await page.getByRole("button", { name: "确认删除用户", exact: true }).click();
  await page
    .getByText("邮箱与所选用户不一致，请重新输入。", { exact: true })
    .waitFor();
  await page
    .getByLabel("输入用户邮箱以确认", { exact: true })
    .fill("member01@example.test");
  await page.screenshot({
    path: join(evidence, "delete-confirm.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认删除用户", exact: true }).click();
  await page.locator("#detail-dialog").waitFor({ state: "hidden" });
  await page.getByText("未找到匹配用户", { exact: true }).waitFor();
  await page.getByRole("button", { name: "数据概览", exact: true }).click();
  await page.getByText("当前服务共 13 个注册账号", { exact: true }).waitFor();
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("2 / 2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看详情" }).click();
  const lastEmail = await page
    .locator("#detail-dialog .user-email")
    .textContent();
  await page.getByRole("button", { name: "删除用户", exact: true }).click();
  await page.getByLabel("输入用户邮箱以确认", { exact: true }).fill(lastEmail);
  await page
    .getByLabel("操作原因", { exact: false })
    .fill("本地验收：末页删除");
  await page.getByRole("button", { name: "确认删除用户", exact: true }).click();
  await page.getByText("1 / 1", { exact: true }).waitFor();
  await page.getByText("共 12 条记录 · 每页 12 条", { exact: true }).waitFor();
  check("删除取消、邮箱确认、删除后关闭详情和末页自动回退");
  await page.setViewportSize({ width: 390, height: 844 });
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
