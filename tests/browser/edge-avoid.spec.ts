// 用途：在真实浏览器里验证连线避让文字：两种走线方式下，连线不穿过别的节点文字、连线文字和子图标题；连线画在节点之上。
import { test, expect, type Page } from '@playwright/test';

const SOURCE = `flowchart LR
  A[开始处理请求] --> B[校验参数]
  B --> C[写入数据库]
  C --> D[返回结果]
  A -->|跳过校验直接写入| C
  A --> D
  B -->|失败| D
  subgraph S[存储层]
    C
    E[缓存]
  end
  A --> E
  E --> D`;

/** 每条连线每隔 2px 取点，统计落进别的文字框（不含自己的连线文字）的点数。 */
async function collisions(page: Page) {
  return page.locator('svg').first().evaluate((svg: SVGSVGElement) => {
    const texts = [...svg.querySelectorAll('g.node foreignObject, .cluster-label foreignObject, .edgeLabels > .edgeLabel foreignObject')]
      .filter(fo => (fo.textContent ?? '').trim())
      .map(fo => ({ owner: fo.closest('.edgeLabel'), r: fo.getBoundingClientRect() }));
    const paths = [...new Set(svg.querySelectorAll<SVGPathElement>('path.flowchart-link, .edgePaths > path'))].filter(p => !p.classList.contains('mp-edge-hit'));
    let hits = 0;
    for (const path of paths) {
      const id = path.getAttribute('data-id');
      const own = id ? svg.querySelector(`.edgeLabel [data-id="${CSS.escape(id)}"]`)?.closest('.edgeLabel') : null;
      const m = path.getScreenCTM()!, len = path.getTotalLength();
      const at = (l: number) => { const p = path.getPointAtLength(l); return new DOMPoint(p.x, p.y).matrixTransform(m); };
      const s = at(0), e = at(len);
      const within = (p: DOMPoint, r: DOMRect, k = 0) => p.x > r.left - k && p.x < r.right + k && p.y > r.top - k && p.y < r.bottom + k;
      const others = texts.filter(t => t.owner !== own || !own).filter(t => !within(s, t.r, 4) && !within(e, t.r, 4));
      for (let l = 0; l <= len; l += 2) { const p = at(l); if (others.some(t => within(p, t.r, -1))) hits++; }
    }
    return { hits, avoided: svg.querySelectorAll('[data-mp-avoided]').length, paths: paths.length };
  });
}

for (const edges of ['curved', 'orthogonal']) {
  test(`${edges === 'curved' ? '曲线' : '直角走线'}：连线绕开文字，并画在节点之上`, async ({ page }) => {
    await page.addInitScript(e => { (window as any).__mpEdges = e; }, edges);
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Mermaid 源码草稿' }).fill(SOURCE);
    await page.getByRole('button', { name: '刷新预览' }).click();
    const svg = page.locator('svg').first();
    await expect(svg.locator('g.node')).toHaveCount(5);
    const result = await collisions(page);
    expect(result.hits).toBe(0);
    // 连线组在节点组之后，连线文字组在最后。
    const order = await svg.evaluate((el: SVGSVGElement) => [...el.querySelector('g.root')!.children].map(c => c.getAttribute('class')));
    expect(order.indexOf('nodes')).toBeLessThan(order.findIndex(c => c?.includes('edgePaths')));
    expect(order.at(-1)).toBe('edgeLabels');
  });
}

/** 先正常画一次，再用位置注释把 C 挪到 A→B 这条跨层长线的正中，逼出压字的情况。 */
const BLOCKED = `flowchart TD
  A[上游节点] --> M[中间层] --> B[下游节点]
  A --> B
  B --> C[挡路的节点]`;

for (const edges of ['curved', 'orthogonal']) {
  test(`${edges === 'curved' ? '曲线' : '直角走线'}：节点挪到线上后，线绕开它的文字`, async ({ page }) => {
    await page.addInitScript(e => { (window as any).__mpEdges = e; }, edges);
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Mermaid 源码草稿' });
    await input.fill(BLOCKED);
    await page.getByRole('button', { name: '刷新预览' }).click();
    const svg = page.locator('svg').first();
    await expect(svg.locator('g.node')).toHaveCount(4);
    const offset = await svg.evaluate((el: SVGSVGElement) => {
      // 源码里第 3 条连线是 A --> B。
      const path = [...new Set(el.querySelectorAll<SVGPathElement>('path.flowchart-link'))][2]!;
      const mid = new DOMPoint(path.getPointAtLength(path.getTotalLength() / 2).x, path.getPointAtLength(path.getTotalLength() / 2).y).matrixTransform(path.getScreenCTM()!);
      const r = el.querySelector('g.node[id*="flowchart-C-"] foreignObject')!.getBoundingClientRect();
      const scale = el.viewBox.baseVal.width / el.getBoundingClientRect().width;
      return [Math.round((mid.x - r.left - r.width / 2) * scale), Math.round((mid.y - r.top - r.height / 2) * scale)];
    });
    await input.fill(`${BLOCKED}\n  %% mermaid-plus-layout: ${JSON.stringify({ version: 1, nodes: { C: offset } })}`);
    await page.getByRole('button', { name: '刷新预览' }).click();
    await expect.poll(async () => (await collisions(page)).avoided).toBeGreaterThan(0);
    expect((await collisions(page)).hits).toBe(0);
  });
}
