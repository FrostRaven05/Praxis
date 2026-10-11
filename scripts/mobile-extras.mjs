import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
async function route(name) {
  await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await page.getByRole('navigation', { name: '功能菜单' }).getByRole('button', { name, exact: true }).click();
}
try {
  await route('搜索与视图');
  await page.getByLabel(/^排序/).selectOption('priority');
  await page.getByLabel(/^分组/).selectOption('project');
  const view = `验收排序视图 ${Date.now()}`;
  await page.getByLabel('视图名称', { exact: true }).fill(view);
  await page.getByRole('button', { name: '保存视图', exact: true }).click();
  await expect(page.getByRole('button', { name: view, exact: true })).toBeVisible();
  await page.getByLabel(/^排序/).selectOption('title');
  await page.getByRole('button', { name: view, exact: true }).click();
  await expect(page.getByLabel(/^排序/)).toHaveValue('priority');
  await route('回顾');
  await page.getByRole('button', { name: '为此项目写回顾', exact: true }).first().click();
  await page.getByLabel('标题', { exact: true }).fill('必须保留的回顾草稿');
  await page.getByRole('button', { name: '为此项目写回顾', exact: true }).last().click();
  await expect(page.getByRole('alertdialog', { name: '替换未保存回顾' })).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button').first().click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('必须保留的回顾草稿');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible();
  await route('我的');
  await page.getByRole('button', { name: '读取历史', exact: true }).click();
  await expect(page.getByText('创建 回顾：必须保留的回顾草稿', { exact: true })).toBeVisible();
  await writeFile(new URL('../docs/evidence/mobile/extras.json', import.meta.url), JSON.stringify({ passed: true, checks: ['saved search restores sorting', 'review replacement preserves draft on cancel', 'review persisted and friendly history shown'] }, null, 2));
  await route('任务清单');
} finally { await browser.close(); }

