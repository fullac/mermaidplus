// 用途：用真实 Mermaid 直角大图验证避让耗时上限，并支持同一浏览器中的修改前后对照。
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

let bundle: string, baseline: string | undefined;
test.beforeAll(async () => {
  const built = await build({ stdin: { contents: "export * from './src/edgeAvoid'; export * from './src/manualLayout'; export * from './src/flowchart'; export { default as mermaid } from 'mermaid';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'edgeTest', target: 'es2022', logLevel: 'silent' });
  bundle = built.outputFiles[0]!.text;
  if (process.env.MP_EDGE_BASELINE) baseline = await readFile(process.env.MP_EDGE_BASELINE, 'utf8');
});

for (const size of [120, 200]) test(`${size} 节点直角交叉图：avoidText 在 500ms 内返回`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setContent('<div id="host"></div>');
  if (baseline) { await page.addScriptTag({ content: baseline }); await page.evaluate(() => { (window as any).beforeEdges = (window as any).edgeTest; }); }
  await page.addScriptTag({ content: bundle });
  const metrics = await page.evaluate(async size => {
    const api = (window as any).edgeTest;
    const source = 'flowchart TD\n' + Array.from({ length: size }, (_, i) => `N${i}[Node ${i}]`).join('\n') + '\n'
      + Array.from({ length: size - 1 }, (_, i) => `N${Math.floor(i / 3)} --> N${i + 1}`).join('\n') + '\n'
      + Array.from({ length: Math.floor((size - 1) / 5) }, (_, i) => `N${i * 5} --> N${Math.min(size - 1, i * 5 + 17)}`).join('\n');
    api.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', layout: 'elk', flowchart: { htmlLabels: true, curve: 'linear' }, elk: { lineHops: 'arc' } });
    const { svg: markup } = await api.mermaid.render('budget-fixture', source);
    const host = document.getElementById('host')!;
    const measure = (implementation: any) => {
      host.innerHTML = markup;
      const svg = host.querySelector('svg')!;
      svg.dataset.mpEdges = 'orthogonal'; svg.dataset.mpHops = 'arc';
      // 保留真实 Mermaid 的节点/标签/边，模拟手动排布后密集遮挡的长线。
      // 自动排版没有碰撞时根本不触发搜索，不能作为预算回归用例。
      [...svg.querySelectorAll<SVGGElement>('g.node')].forEach((node, i) => {
        const b = node.getBBox();
        node.setAttribute('transform', `translate(${20 + i % 15 * 7 - b.x},${20 + i * 12 - b.y})`);
      });
      const paths = [...svg.querySelectorAll<SVGPathElement>('path.flowchart-link')];
      const boxes = [...svg.querySelectorAll<SVGGElement>('g.node')].map(node => { const b = node.getBBox(), m = svg.getCTM()!.inverse().multiply(node.getCTM()!); return { x: b.x + m.e, y: b.y + m.f, width: b.width, height: b.height }; });
      const x = (Math.min(...boxes.map(b => b.x)) + Math.max(...boxes.map(b => b.x + b.width))) / 2;
      const path = paths[0]!, m = svg.getCTM()!.inverse().multiply(path.getCTM()!);
      const top = Math.min(...boxes.map(b => b.y)) - 20, bottom = Math.max(...boxes.map(b => b.y + b.height)) + 20;
      path.setAttribute('d', `M${x - m.e},${top - m.f}L${x - m.e},${bottom - m.f}`);
      const blocked = boxes.filter(b => api.polylineHits([{ x, y: top }, { x, y: bottom }], [b])).length;
      const started = performance.now(), changed = implementation.avoidText(svg), avoidMs = performance.now() - started;
      const mover = implementation.createMover(svg, api.parseFlowchart(source));
      const drag = performance.now(); mover.move({ N1: [15, 5] }, false); const dragMs = performance.now() - drag;
      return { blocked, avoidMs: +avoidMs.toFixed(2), dragMs: +dragMs.toFixed(2), changed };
    };
    const before = (window as any).beforeEdges ? measure((window as any).beforeEdges) : undefined;
    return { size, before, after: measure(api) };
  }, size);
  console.log('edge budget', JSON.stringify(metrics));
  await info.attach('edge-budget', { body: JSON.stringify(metrics), contentType: 'application/json' });
  expect(metrics.after.blocked).toBeGreaterThan(40);
  expect(metrics.after.avoidMs).toBeLessThan(500);
});

test('拖动帧不计算跳线，落点后才恢复交叉半圆', async ({ page }) => {
  await page.setContent('<div id="host"></div>');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const api = (window as any).edgeTest, host = document.getElementById('host')!;
    host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 180" data-mp-edges="orthogonal" data-mp-hops="arc"><g class="nodes"><g class="node" data-id="A" transform="translate(100,10)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="B" transform="translate(100,150)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="C" transform="translate(10,60)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="D" transform="translate(190,60)"><rect x="-10" y="-10" width="20" height="20"/></g></g><g class="edgePaths"><path class="flowchart-link" d="M100,20L100,140"/><path class="flowchart-link" d="M20,60L180,60"/></g></svg>';
    const svg = host.querySelector('svg')!, mover = api.createMover(svg, api.parseFlowchart('flowchart TD\nA-->B\nC-->D'));
    const observer = new MutationObserver(() => {});
    observer.observe(svg, { attributes: true, subtree: true, attributeFilter: ['data-mp-hopped-d'] });
    mover.move({ A: [10, 0] }, false);
    const frameWrites = observer.takeRecords().length;
    mover.move({ A: [10, 0] }, true);
    const finalWrites = observer.takeRecords().length;
    observer.disconnect();
    return { frameWrites, finalWrites, d: svg.querySelectorAll('path.flowchart-link')[1]!.getAttribute('d') };
  });
  expect(result.frameWrites).toBe(0); expect(result.finalWrites).toBeGreaterThan(0); expect(result.d).toContain('A5,5');
});
