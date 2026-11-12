// 用途：验证嵌套子图框、跨层连线和换行节点文字在增强预览中完整可见。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { findMermaidBlocks, parseFlowchart } from '../../src/flowchart';

const source = findMermaidBlocks(readFileSync('examples/subgraph.md', 'utf8'))[0]!.source;
const chart = parseFlowchart(source);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('渲染完成');
});

test('子图框包住所属节点，换行文字不被裁切', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Mermaid 源码草稿' }).fill(source);
  await page.getByRole('button', { name: '刷新预览' }).click();
  await expect(page.getByRole('status')).toContainText('渲染完成');
  await expect(page.locator('.mp-enhanced [data-group-id]')).toHaveCount(3);
  await expect(page.locator('.mp-enhanced [data-node-id]')).toHaveCount(9);
  await expect(page.locator('.mp-enhanced .mp-edge')).toHaveCount(9);

  const geometry = await page.locator('.mp-enhanced svg').evaluate(svg => {
    const boxOf = (selector: string) => {
      const node = svg.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    };
    const parents: Record<string, string | null> = {};
    for (const node of svg.querySelectorAll<SVGElement>('[data-node-id]')) {
      const id = node.dataset.nodeId!;
      const nodeBox = node.querySelector('.mp-node-shape')!.getBoundingClientRect();
      let owner: string | null = null;
      for (const group of svg.querySelectorAll<SVGElement>('[data-group-id]')) {
        const groupBox = group.querySelector('.mp-group-shape')!.getBoundingClientRect();
        const inside = nodeBox.left >= groupBox.left - 0.5 && nodeBox.right <= groupBox.right + 0.5
          && nodeBox.top >= groupBox.top - 0.5 && nodeBox.bottom <= groupBox.bottom + 0.5;
        if (!inside) continue;
        if (!owner) owner = group.dataset.groupId!;
        else {
          const current = svg.querySelector(`[data-group-id="${owner}"] .mp-group-shape`)!.getBoundingClientRect();
          if (groupBox.width * groupBox.height < current.width * current.height) owner = group.dataset.groupId!;
        }
      }
      parents[id] = owner;
    }
    const clipped = [...svg.querySelectorAll('[data-node-id]')].filter(node => {
      const box = node.querySelector('foreignObject')!.getBoundingClientRect();
      const label = node.querySelector('.mp-node-label')!.getBoundingClientRect();
      return label.left < box.left - 0.5 || label.right > box.right + 0.5
        || label.top < box.top - 0.5 || label.bottom > box.bottom + 0.5;
    }).map(node => (node as SVGElement).dataset.nodeId);
    return { parents, clipped, groups: [...svg.querySelectorAll('[data-group-id]')].map(group => (group as SVGElement).dataset.groupId) };
  });

  expect(geometry.groups).toEqual(chart.groups.map(group => group.id));
  for (const node of chart.nodes) expect(geometry.parents[node.id], node.id).toBe(node.parent ?? null);
  expect(geometry.clipped).toEqual([]);
  await expect(page.locator('[data-node-id="MA"] .mp-node-label')).toContainText('用户对话与任务委派');
});
