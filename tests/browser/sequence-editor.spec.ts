// 用途：在演示页验证时序图编辑：出现源码/编辑，改一条消息只动该行，含 alt 的控制块原样保留。
import { test, expect, type Page } from '@playwright/test';

const editor = (page: Page) => page.getByRole('group', { name: 'Mermaid 时序图编辑' });
const sourceText = (page: Page) => page.getByLabel('当前源码').textContent().then(text => text ?? '');
const status = (page: Page) => editor(page).getByRole('status');

test('时序图出现源码和编辑按钮', async ({ page }) => {
  await page.goto('/#sequence');
  await expect(page.getByRole('toolbar', { name: '时序图操作' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: '时序图操作' }).getByRole('button', { name: '源码' })).toBeVisible();
  await expect(page.getByRole('button', { name: '在图上编辑这张时序图' })).toBeVisible();
  await expect(editor(page).getByRole('button', { name: '源码' })).toBeVisible();
  await expect(status(page)).toContainText('单击选中');
  await expect(editor(page).locator('[data-edge-index="0"]:not(.mp-edge-hit)')).toHaveCount(2);
});

test('改一条消息后只有该行变化', async ({ page }) => {
  await page.goto('/#sequence');
  await expect(status(page)).toContainText('单击选中');
  const before = await sourceText(page);
  await editor(page).locator('text.messageText').filter({ hasText: '查询' }).dblclick();
  const box = page.getByRole('textbox', { name: '消息文字' });
  await expect(box).toHaveValue('查询');
  await box.fill('查询订单');
  await box.press('Enter');
  await expect(editor(page).locator('text.messageText').filter({ hasText: '查询订单' })).toBeVisible();
  const after = await sourceText(page);
  const changed = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
  expect(changed).toEqual(['    用户->>API: 查询订单']);
  expect(after).toContain('API-->>用户: 返回结果');
  expect(after).toContain('Note over 用户,API: 同步完成');
});

test('含 alt 的图可以改文字，控制块原样保留', async ({ page }) => {
  await page.goto('/#sequence-alt');
  await expect(status(page)).toContainText('只能修改文字');
  await expect(editor(page).getByRole('button', { name: '新增参与者' })).toBeDisabled();
  await expect(editor(page).getByRole('button', { name: '新增消息' })).toBeDisabled();
  const before = await sourceText(page);
  await editor(page).locator('text.messageText').filter({ hasText: '请求' }).dblclick();
  const box = page.getByRole('textbox', { name: '消息文字' });
  await box.fill('新请求');
  await box.press('Enter');
  const after = await sourceText(page);
  expect(after).toContain('A->>B: 新请求');
  expect(after).toContain('    alt 成功');
  expect(after).toContain('    else 失败');
  expect(after).toContain('    end');
  expect(after).toContain('B-->>A: 好');
  const changed = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
  expect(changed).toEqual(['    A->>B: 新请求']);
});

test('外部改源码时保留正在输入的消息文字', async ({ page }) => {
  await page.goto('/#sequence');
  await expect(status(page)).toContainText('单击选中');
  await editor(page).locator('text.messageText').filter({ hasText: '查询' }).dblclick();
  const box = page.getByRole('textbox', { name: '消息文字' });
  await box.fill('还没保存');
  await page.evaluate(() => {
    const editor = (document.querySelector('#app') as HTMLElement & { __editor?: { update(source: string): void } }).__editor;
    const current = document.querySelector('[aria-label="当前源码"]')?.textContent ?? '';
    editor?.update(current.replace('查询', '外部查询'));
  });
  await expect(status(page)).toContainText('正在输入的文字已保留');
  await expect(page.getByRole('textbox', { name: '消息文字' })).toHaveValue('还没保存');
});
