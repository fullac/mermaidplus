// 用途：以真实浏览器验证普通渲染、注释增强、失效保护以及节点文字是否被裁切。
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('渲染完成');
});

test('同一份源码保留普通文字，同时恢复四种样式且不裁切', async ({ page }) => {
  await expect(page.locator('.mp-standard svg')).toBeVisible();
  await expect(page.locator('.mp-standard')).toContainText('getUser()');
  await expect(page.locator('.mp-standard')).not.toContainText('mermaid-plus');
  await expect(page.locator('.mp-enhanced .mp-style-code')).toHaveText('getUser()');
  await expect(page.locator('.mp-enhanced .mp-style-bold')).toHaveText('检查权限');
  await expect(page.locator('.mp-enhanced .mp-style-italic')).toHaveText('请稍后再试');
  await expect(page.locator('.mp-enhanced .mp-style-highlight')).toHaveText('失败时重试');
  const clipped = await page.locator('.mp-enhanced foreignObject').evaluateAll(objects => objects.filter(object => {
    const box = object.getBoundingClientRect();
    const label = object.querySelector('.mp-node-label')!.getBoundingClientRect();
    return label.left < box.left || label.right > box.right || label.top < box.top || label.bottom > box.bottom;
  }).length);
  expect(clipped).toBe(0);
  await expect(page.locator('.mp-style-bold')).toHaveCSS('font-weight', '700');
  await expect(page.locator('.mp-style-highlight')).toHaveCSS('background-color', 'rgb(247, 223, 115)');
  await page.screenshot({ path: 'test-results/annotation-preview.png', fullPage: true });
});

test('添加样式只改变注释，支持同一文字叠加样式', async ({ page }) => {
  const textarea = page.getByRole('textbox', { name: 'Mermaid 源码草稿' });
  const before = await textarea.inputValue();
  await page.getByLabel('文字片段').fill('getUser()');
  await page.getByLabel('样式', { exact: true }).selectOption('highlight');
  await page.getByRole('button', { name: '添加样式' }).click();
  await expect(page.locator('.mp-style-code.mp-style-highlight')).toHaveText('getUser()');
  const withoutAnnotations = (text: string) => text.split('\n').filter(line => !line.includes('%% mermaid-plus:')).join('\n');
  expect(withoutAnnotations(await textarea.inputValue())).toBe(withoutAnnotations(before));
  await page.getByRole('button', { name: '清除该节点样式' }).click();
  await expect(page.locator('[data-node-id="A"] .mp-style-code')).toHaveCount(0);
});

test('修改节点文字后旧样式不会错绑；损坏注释不破坏普通渲染', async ({ page }) => {
  const textarea = page.getByRole('textbox', { name: 'Mermaid 源码草稿' });
  const source = await textarea.inputValue();
  await textarea.fill(source.replace('A["调用 getUser()，检查权限"]', 'A["调用 getAccount()，检查权限"]'));
  await page.getByRole('button', { name: '刷新预览' }).click();
  await expect(page.getByRole('status')).toContainText('原始文字已变化');
  await expect(page.locator('.mp-enhanced .mp-style-code')).toHaveCount(0);
  await textarea.fill(source.replace('{"version":1,"node":"A"', '{broken,"node":"A"'));
  await page.getByRole('button', { name: '刷新预览' }).click();
  await expect(page.getByRole('status')).toContainText('样式注释无效');
  await expect(page.locator('.mp-standard svg')).toBeVisible();
});

test('未知语法明确停止增强；恢复示例可以继续使用', async ({ page }) => {
  const textarea = page.getByRole('textbox', { name: 'Mermaid 源码草稿' });
  const unknown = 'flowchart TD\nA & B --> C';
  await textarea.fill(unknown);
  await page.getByRole('button', { name: '刷新预览' }).click();
  await expect(page.locator('.mp-enhanced')).toContainText('暂时不支持增强显示');
  expect(await textarea.inputValue()).toBe(unknown);
  await expect(page.getByRole('button', { name: '添加样式' })).toBeDisabled();
  await page.getByRole('button', { name: '恢复初始示例' }).click();
  await expect(page.getByRole('status')).toContainText('渲染完成');
});

test('预览容器缩放时仍按未缩放尺寸布局，未知版本注释不会被改写', async ({ page }) => {
  await page.addStyleTag({ content: '.mp-playground { transform: scale(.65); transform-origin: top left; }' });
  await page.getByRole('button', { name: '刷新预览' }).click();
  await expect(page.getByRole('status')).toContainText('渲染完成');
  const clipped = await page.locator('.mp-enhanced foreignObject').evaluateAll(objects => objects.some(object => {
    const box = object.getBoundingClientRect(), label = object.querySelector('.mp-node-label')!.getBoundingClientRect();
    return label.width > box.width || label.height > box.height;
  }));
  expect(clipped).toBe(false);
  const textarea = page.getByRole('textbox', { name: 'Mermaid 源码草稿' });
  const future = (await textarea.inputValue()).replace('{"version":1,"node":"A"', '{"version":2,"node":"A"');
  await textarea.fill(future);
  await page.getByRole('button', { name: '刷新预览' }).click();
  await expect(page.getByRole('status')).toContainText('样式注释无效');
  await page.getByLabel('文字片段').fill('getUser()');
  await page.getByRole('button', { name: '添加样式' }).click();
  await expect(page.getByRole('status')).toContainText('版本不认识');
  expect(await textarea.inputValue()).toBe(future);
});
