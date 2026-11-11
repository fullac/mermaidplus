// 用途：验证自动整理、布局控件、长标签换行和快速切换后的预览一致性。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { findMermaidBlocks } from '../../src/flowchart';

const complex = findMermaidBlocks(readFileSync('examples/auto-layout.md', 'utf8'))[0]!.source;
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('渲染完成');
});

test('多分支和回路自动排版、长文字换行且节点不重叠', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Mermaid 源码草稿' }).fill(complex);
  await page.getByRole('button', { name: '自动整理' }).click();
  await expect(page.locator('.mp-enhanced [data-node-id]')).toHaveCount(9);
  await expect(page.getByRole('status')).toContainText('渲染完成');
  await expect(page.locator('.mp-enhanced .mp-edge')).toHaveCount(10);
  expect(await page.locator('.mp-enhanced .mp-edge').evaluateAll(paths => paths.some(p => p.getAttribute('d')!.includes('Q')))).toBe(true);
  const geometry = await page.locator('.mp-enhanced [data-node-id]').evaluateAll(nodes => {
    const boxes = nodes.map(n => n.querySelector('.mp-node-shape')!.getBoundingClientRect());
    const overlaps = boxes.some((a, i) => boxes.some((b, j) => j > i && a.left < b.right-.1 && a.right > b.left+.1 && a.top < b.bottom-.1 && a.bottom > b.top+.1));
    const clipped = nodes.some(n => {
      const box = n.querySelector('foreignObject')!.getBoundingClientRect(), label = n.querySelector('.mp-node-label')!.getBoundingClientRect();
      return label.left < box.left || label.right > box.right || label.top < box.top || label.bottom > box.bottom;
    });
    const wrapped = nodes.some(n => {
      const label = n.querySelector<HTMLElement>('.mp-node-label')!;
      return label.offsetHeight > parseFloat(getComputedStyle(label).lineHeight) * 1.5;
    });
    return { overlaps, clipped, wrapped };
  });
  expect(geometry.overlaps).toBe(false);
  expect(geometry.clipped).toBe(false);
  expect(geometry.wrapped).toBe(true);
  await page.getByRole('button', { name: '展开增强图' }).click();
  await expect(page.getByRole('status')).toContainText('渲染完成');
  await expect(page.locator('.mp-standard')).not.toBeVisible();
  await page.screenshot({ path: 'test-results/auto-layout-preview.png', fullPage: true });
});

test('方向、疏密和折线样式可切换，源码保持原样', async ({ page }) => {
  const source = page.getByRole('textbox', { name: 'Mermaid 源码草稿' }), before = await source.inputValue();
  const svg = page.locator('.mp-enhanced svg');
  await page.getByLabel('排版方向', { exact: true }).selectOption('LR');
  await expect(svg).toHaveAttribute('data-direction', 'LR');
  await page.getByLabel('排版方向', { exact: true }).selectOption('TB');
  await expect(svg).toHaveAttribute('data-direction', 'TB');
  await page.getByLabel('节点间距', { exact: true }).selectOption('compact');
  await expect(page.getByRole('status')).toContainText('渲染完成');
  const compact = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  await page.getByLabel('节点间距', { exact: true }).selectOption('roomy');
  await expect(page.getByRole('status')).toContainText('渲染完成');
  const roomy = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
  expect(roomy[2]! * roomy[3]!).toBeGreaterThan(compact[2]! * compact[3]!);
  await page.getByLabel('连线样式', { exact: true }).selectOption('orthogonal');
  await expect(page.getByRole('status')).toContainText('渲染完成');
  expect(await page.locator('.mp-enhanced .mp-edge').evaluateAll(paths => paths.every(p => !p.getAttribute('d')!.includes('Q')))).toBe(true);
  expect(await source.inputValue()).toBe(before);
});

test('快速连续整理只展示最新草稿，临时渲染容器会释放', async ({ page }) => {
  const textarea = page.getByRole('textbox', { name: 'Mermaid 源码草稿' });
  await textarea.fill(complex);
  await page.getByRole('button', { name: '自动整理' }).click();
  await textarea.fill('flowchart LR\nA["最后一次修改"] --> B["完成"]');
  await page.getByRole('button', { name: '自动整理' }).click();
  await expect(page.locator('.mp-enhanced')).toContainText('最后一次修改');
  await expect(page.locator('.mp-standard')).toContainText('最后一次修改');
  await expect(page.locator('.mp-enhanced [data-node-id]')).toHaveCount(2);
  await expect(page.locator('.mp-enhanced-staging')).toHaveCount(0);
  await expect(page.locator('.mp-native-staging')).toHaveCount(0);
});

test('复杂图计算在独立线程中，切换示例可中止计算并释放线程', async ({ page }) => {
  let started = 0, closed = 0;
  page.on('worker', worker => { started++; worker.on('close', () => closed++); });
  const graph = 'flowchart TD\n' + Array.from({ length: 100 }, (_, i) => `N${i} --> N${(i+1)%100}\nN${i} --> N${(i+37)%100}`).join('\n');
  await page.getByRole('textbox', { name: 'Mermaid 源码草稿' }).fill(graph);
  const workerStarted = page.waitForEvent('worker');
  await page.getByRole('button', { name: '自动整理' }).click();
  await workerStarted;
  await page.getByRole('button', { name: '样式示例', exact: true }).click();
  await expect(page.locator('.mp-enhanced')).toContainText('getUser()');
  await expect(page.getByRole('status')).toContainText('渲染完成');
  expect(started).toBeGreaterThanOrEqual(2);
  await expect.poll(() => closed).toBe(started);
});
