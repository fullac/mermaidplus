// 用途：隔离宿主验证问题 1–6 的真实 SVG、原子替换、背景、主题和编辑调度，不访问 Obsidian 文件。
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

let bundle: string, css: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `export * from './src/mermaidRender'; export * from './src/blockEditor'; export * from './src/manualLayout'; export * from './src/flowchart'; export * from './src/edgeAvoid';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'mp', target: 'es2022', logLevel: 'silent' });
  bundle = result.outputFiles[0]!.text;
  css = await readFile('styles.css', 'utf8');
});
test.beforeEach(async ({ page }) => {
  await page.setContent('<body><div id="host" style="width:700px"></div></body>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
});

test('位置注释在隐藏容器中应用，最后只替换一次；失败保留旧图', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).mp, target = document.getElementById('host')!;
    await api.renderMermaid('flowchart TD\nA[旧图] --> B[结果]', target);
    let replacements = 0;
    const replace = target.replaceChildren.bind(target);
    target.replaceChildren = (...nodes: (Node | string)[]) => { replacements++; replace(...nodes); };
    await api.renderMermaid('flowchart TD\nA[新图] --> B[结果]\n%% mermaid-plus-layout: {"version":1,"nodes":{"A":[50,0]}}', target);
    const svg = target.querySelector('svg');
    try { await api.renderMermaid('flowchart TD\nA --> [', target); } catch { /* 预期失败 */ }
    return { replacements, kept: target.querySelector('svg') === svg, text: target.textContent, staging: document.querySelectorAll('.mp-render-staging').length };
  });
  expect(result.replacements).toBe(1); expect(result.kept).toBe(true); expect(result.text).toContain('新图'); expect(result.staging).toBe(0);
});

test('窄图的背景铺满正文栏，SVG 透明且居中，清空设置可移除底色', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).mp, target = document.getElementById('host')!;
    await api.renderMermaid('flowchart TD\nA[小图]', target, { ...api.DEFAULT_RENDER_SETTINGS, background: '#123456' });
    const svg = target.querySelector('svg')!, a = target.getBoundingClientRect(), b = svg.getBoundingClientRect();
    const data = { width: a.width, graphWidth: b.width, center: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), background: getComputedStyle(target).backgroundColor, svgBackground: getComputedStyle(svg).backgroundColor };
    await api.renderMermaid('flowchart TD\nA[小图]', target, { ...api.DEFAULT_RENDER_SETTINGS, background: '' });
    return { ...data, cleared: target.style.backgroundColor };
  });
  expect(result.width).toBe(700); expect(result.graphWidth).toBeLessThan(700); expect(result.center).toBeLessThan(1);
  expect(result.background).toBe('rgb(18, 52, 86)'); expect(result.svgBackground).toBe('rgba(0, 0, 0, 0)'); expect(result.cleared).toBe('');
});

test('选择跟随明暗时：暗色主题、文字对比度及编辑控件；保留显式底色', async ({ page }, info) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    document.body.classList.add('theme-dark');
    document.body.style.backgroundColor = '#202124';
    const auto = { ...api.DEFAULT_RENDER_SETTINGS, theme: 'auto', background: '' };
    const svg = await api.renderMermaid('flowchart TD\nsubgraph S[分组]\nA[节点] -->|连线| B[结果]\nend', host, auto);
    const fill = getComputedStyle(svg.querySelector('g.node rect')).fill;
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => { const n = c / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
      return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
    };
    const contrast = (foreground: string, background: string) => {
      const a = luminance(foreground), b = luminance(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const nodeContrast = contrast(getComputedStyle(svg.querySelector('.nodeLabel')!).color, fill);
    const groupContrast = contrast(getComputedStyle(svg.querySelector('.cluster-label p')!).color, getComputedStyle(svg.querySelector('.cluster > rect')!).fill);
    const edgeContrast = contrast(getComputedStyle(svg.querySelector('.edgeLabel p')!).color, 'rgb(32, 33, 36)');
    await api.renderMermaid('flowchart TD\nA[显式]', host, { ...api.DEFAULT_RENDER_SETTINGS, theme: 'default', background: '#fafafa' });
    const explicit = host.style.backgroundColor;
    host.replaceChildren();
    const editor = api.mountBlockEditor(host, 'flowchart TD\nA[节点]', {
      draw: async (source: string, target: HTMLElement) => { await api.renderMermaid(source, target, auto); },
      commit: async () => true, undo: async () => null, redo: async () => null, exit() {},
    });
    (window as any).editor = editor;
    return { fill, nodeContrast, groupContrast, edgeContrast, explicit, bg: getComputedStyle(host.querySelector('.mp-block-editor')!).backgroundColor, button: getComputedStyle(host.querySelector('button')!).backgroundColor };
  });
  expect(result.fill).not.toBe('rgb(236, 236, 255)');
  expect(result.nodeContrast).toBeGreaterThan(4.5); expect(result.groupContrast).toBeGreaterThan(4.5); expect(result.edgeContrast).toBeGreaterThan(4.5);
  expect(result.explicit).toBe('rgb(250, 250, 250)');
  expect(result.bg).toBe('rgb(32, 33, 36)'); expect(result.button).toBe('rgb(41, 43, 48)');
  await expect(page.locator('[data-node-id="A"]')).toBeVisible();
  await page.locator('[data-node-id="A"]').dblclick();
  await expect(page.getByRole('textbox', { name: '节点文字' })).toHaveCSS('color', 'rgb(227, 229, 232)');
  const format = await page.getByRole('toolbar', { name: '文字格式' }).boundingBox();
  const stage = await page.locator('.mp-editor-stage').boundingBox();
  expect(format!.y + format!.height).toBeLessThanOrEqual(stage!.y + stage!.height);
  await page.screenshot({ path: info.outputPath('dark-editor.png') });
});

for (const mode of ['arc', 'gap', 'none']) test(`拖动后全图重算 ${mode}，重复移动不累积装饰，点击线保持连续`, async ({ page }) => {
  const result = await page.evaluate((mode) => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 200" data-mp-edges="orthogonal" data-mp-hops="${mode}"><g class="root" transform="translate(12,18)"><g class="nodes"><g class="node" data-id="A" transform="translate(100,10)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="B" transform="translate(100,150)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="C" transform="translate(10,60)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="D" transform="translate(190,60)"><rect x="-10" y="-10" width="20" height="20"/></g></g><g class="edgePaths"><path class="flowchart-link" d="M100,20L100,140"/><path class="flowchart-link" d="M20,60L180,60"/></g></g></svg>`;
    const svg = host.querySelector('svg')!, chart = api.parseFlowchart('flowchart TD\nA-->B\nC-->D');
    api.tagMermaidSvg(svg, chart);
    const mover = api.createMover(svg, chart);
    mover.move({ A: [10, 0] });
    const path = svg.querySelectorAll('path.flowchart-link')[1]!;
    const first = path.getAttribute('d'), mask = path.hasAttribute('mask');
    mover.move({ A: [10, 0] });
    const repeated = path.getAttribute('d');
    const hit = path.nextElementSibling!.getAttribute('d');
    mover.move({ A: [150, 0], B: [150, 0] });
    return { first, repeated, mask, hit, end: path.getAttribute('d'), endMask: path.hasAttribute('mask') };
  }, mode);
  expect(result.first).toBe(result.repeated); expect(result.first!.includes('A')).toBe(mode === 'arc');
  expect(result.mask).toBe(mode === 'gap'); expect(result.hit).not.toContain('A');
  expect(result.end).not.toContain('A'); expect(result.endMask).toBe(false);
});

test('连续更新只绘制最后版本，位置微调不重画，文字先更新，后台失败保留画面', async ({ page }) => {
  await page.evaluate(async () => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    (window as any).draws = []; (window as any).finished = 0; (window as any).failDraw = false;
    (window as any).editor = api.mountBlockEditor(host, 'flowchart TD\nA[初始] --> B[结果]', {
      draw: async (source: string, target: HTMLElement) => {
        (window as any).draws.push(source);
        await new Promise(resolve => setTimeout(resolve, 150));
        if ((window as any).failDraw) throw new Error('模拟失败');
        await api.renderMermaid(source, target);
        (window as any).finished = (window as any).draws.length;
      },
      commit: async () => true, undo: async () => null, redo: async () => null, exit() {},
    });
  });
  const node = page.locator('.mp-editor-canvas [data-node-id="A"]');
  await expect(node).toContainText('初始');
  await page.evaluate(() => { for (let i = 0; i < 12; i++) (window as any).editor.update(`flowchart TD\nA[版本${i}] --> B[结果]`); });
  await expect(node).toContainText('版本11');
  expect(await page.evaluate(() => (window as any).draws.length)).toBe(2);
  await node.click();
  await page.getByRole('group', { name: 'Mermaid 可视化编辑' }).press('ArrowRight');
  await expect.poll(() => page.evaluate(() => (window as any).editor.source())).toContain('mermaid-plus-layout');
  expect(await page.evaluate(() => (window as any).draws.length)).toBe(2);
  await node.dblclick();
  await page.getByRole('textbox', { name: '节点文字' }).fill('立即显示');
  await page.getByRole('textbox', { name: '节点文字' }).press('Enter');
  await expect(node).toContainText('立即显示');
  expect(await page.evaluate(() => (window as any).draws.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).finished)).toBe(3);
  await expect(node).toContainText('立即显示');
  await page.evaluate(() => { (window as any).failDraw = true; (window as any).editor.update('flowchart TD\nA[失败版本] --> B[结果]'); });
  await expect(page.getByRole('status')).toContainText('模拟失败');
  await expect(node).toContainText('立即显示');
  await node.dblclick();
  await page.getByRole('textbox', { name: '节点文字' }).fill('预览后失败');
  await page.getByRole('textbox', { name: '节点文字' }).press('Enter');
  await expect(page.getByRole('status')).toContainText('模拟失败');
  await expect(node).toContainText('立即显示');
});

test('过期渲染和过期错误均不触碰可见容器', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    await api.renderMermaid('flowchart TD\nA[原图]', host);
    let swaps = 0;
    const replace = host.replaceChildren.bind(host);
    host.replaceChildren = (...nodes: (Node | string)[]) => { swaps++; replace(...nodes); };
    const results = await Promise.allSettled([
      api.renderMermaid('flowchart TD\nA[过期图]', host),
      api.renderMermaid('flowchart TD\nA --> [', host),
      api.renderMermaid('flowchart TD\nA[最终图]', host),
    ]);
    return { swaps, text: host.textContent, rejected: results.filter(r => r.status === 'rejected').length };
  });
  expect(result.swaps).toBe(1); expect(result.text).toContain('最终图'); expect(result.rejected).toBe(0);
});

for (const size of [20, 100, 300]) test(`${size} 节点：记录首次排版与免重绘微调耗时`, async ({ page }, info) => {
  await page.evaluate((size) => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    const source = 'flowchart TD\n' + Array.from({ length: size - 1 }, (_, i) => `N${i}[节点${i}] --> N${i + 1}[节点${i + 1}]`).join('\n');
    (window as any).draws = [];
    (window as any).editor = api.mountBlockEditor(host, source, {
      draw: async (s: string, t: HTMLElement) => { (window as any).draws.push(s); await api.renderMermaid(s, t); },
      commit: async () => true, undo: async () => null, redo: async () => null, exit() {},
    });
  }, size);
  await expect(page.locator('.mp-editor-canvas [data-node-id]')).toHaveCount(size);
  const metric = await page.evaluate(async (count) => {
    const root = document.querySelector<HTMLElement>('.mp-block-editor')!;
    document.querySelector('[data-node-id="N0"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const before = (window as any).draws?.length ?? 0, started = performance.now();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // 等写回 promise 和位置更新完成，不等待浏览器绘制下一帧。
    await Promise.resolve(); await Promise.resolve();
    return { nodes: count, moveMs: +(performance.now() - started).toFixed(2), before, after: (window as any).draws?.length ?? 0, moved: (window as any).editor.source().includes('mermaid-plus-layout') };
  }, size);
  expect(metric.moved).toBe(true); expect(metric.after).toBe(metric.before);
  await info.attach('timing', { body: JSON.stringify(metric), contentType: 'application/json' });
  console.log('layout timing', metric);
});

test('刷新设置不取消正在输入的草稿；节点移动后自环跟随', async ({ page }) => {
  await page.evaluate(() => {
    const api = (window as any).mp;
    (window as any).editor = api.mountBlockEditor(document.getElementById('host'), 'flowchart TD\nA[原名] --> A', {
      draw: async (s: string, t: HTMLElement) => { await api.renderMermaid(s, t); },
      commit: async () => true, undo: async () => null, redo: async () => null, exit() {},
    });
  });
  const node = page.locator('.mp-editor-canvas [data-node-id="A"]');
  await expect(node).toBeVisible();
  await node.dblclick();
  const input = page.getByRole('textbox', { name: '节点文字' });
  await input.fill('未提交的草稿');
  await page.evaluate(() => (window as any).editor.update((window as any).editor.source()));
  await expect(input).toHaveValue('未提交的草稿');
  await page.evaluate(() => (window as any).editor.update('flowchart TD\nA[外部] --> A'));
  await expect(page.getByRole('status')).toContainText('正在输入的文字已保留');
  await expect(page.getByRole('textbox', { name: '节点文字' })).toHaveValue('未提交的草稿');
  await page.getByRole('textbox', { name: '节点文字' }).press('Enter');
  await expect(node).toContainText('未提交的草稿');
  const path = page.locator('.mp-editor-canvas path.flowchart-link').first();
  const before = await path.getAttribute('d');
  await node.click();
  await page.getByRole('group', { name: 'Mermaid 可视化编辑' }).press('ArrowRight');
  await expect(path).not.toHaveAttribute('d', before!);
});

for (const edges of ['curved', 'orthogonal']) test(`${edges}：无关节点移到线的空白边缘时，整框避让`, async ({ page }) => {
  const result = await page.evaluate((edges) => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" data-mp-edges="${edges}" data-mp-hops="none"><g class="root"><g class="nodes"><g class="node" data-id="A" transform="translate(10,60)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="B" transform="translate(210,60)"><rect x="-10" y="-10" width="20" height="20"/></g><g class="node" data-id="C" transform="translate(110,140)"><rect x="-30" y="-20" width="60" height="40"/><foreignObject x="-10" y="5" width="20" height="10"><div xmlns="http://www.w3.org/1999/xhtml">文字</div></foreignObject></g></g><g class="edgePaths"><path class="flowchart-link" d="M20,60L200,60"/></g></g></svg>`;
    const svg = host.querySelector('svg')!, chart = api.parseFlowchart('flowchart LR\nA-->B\nC[文字]');
    const mover = api.createMover(svg, chart); mover.move({ C: [0, -70] });
    const points = api.flattenPath(svg.querySelector('path.flowchart-link')!.getAttribute('d'));
    return { hits: api.polylineHits(points, [mover.box('C')]), changed: svg.querySelector('[data-mp-avoided]') !== null };
  }, edges);
  expect(result.hits).toBe(false); expect(result.changed).toBe(true);
});

test('超宽图保留可读字号，通过容器横向滚动访问右侧', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    await api.renderMermaid('flowchart LR\n' + Array.from({ length: 19 }, (_, i) => `N${i}[处理节点${i}] --> N${i + 1}[处理节点${i + 1}]`).join('\n'), host);
    const svg = host.querySelector('svg')!, a = host.getBoundingClientRect(), b = svg.getBoundingClientRect();
    host.scrollLeft = host.scrollWidth;
    return { column: host.clientWidth, content: host.scrollWidth, left: b.left - a.left, scroll: host.scrollLeft, scale: b.width / svg.viewBox.baseVal.width };
  });
  expect(result.column).toBe(700); expect(result.content).toBeGreaterThan(700); expect(result.scroll).toBeGreaterThan(0);
  expect(result.left).toBeGreaterThanOrEqual(0); expect(result.scale).toBeGreaterThanOrEqual(0.649);
});

test('复用宿主插入原生图时立即隐藏，保留插件图、工具栏和源码', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.getElementById('host')!;
    host.className = 'mp-edit-host';
    host.innerHTML = '<div class="mp-diagram-svg">插件图</div><div class="mp-entry-bar"><button class="mp-entry-button">工具栏</button></div><pre class="mp-source-view">源码</pre><div class="plugin-extra">其他插件</div>';
    for (const name of ['mermaid', 'block-language-mermaid']) {
      const native = document.createElement('div'); native.className = name; native.textContent = '原生图'; host.append(native);
    }
    const pre = document.createElement('pre');
    const code = document.createElement('code'); code.className = 'language-mermaid'; pre.append(code); host.append(pre);
  });
  await expect(page.locator('.mermaid')).toBeHidden();
  await expect(page.locator('.block-language-mermaid')).toBeHidden();
  await expect(page.locator('pre:has(> code.language-mermaid)')).toBeHidden();
  await expect(page.locator('.plugin-extra')).toBeVisible();
  await expect(page.locator('.mp-diagram-svg')).toBeVisible();
  await expect(page.locator('.mp-source-view')).toBeVisible();
  await expect(page.locator('.mp-entry-bar')).not.toHaveCSS('display', 'none');
  const button = page.locator('.mp-entry-button');
  const rest = await button.evaluate(el => getComputedStyle(el).backgroundColor);
  await button.hover();
  await expect.poll(() => button.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(rest);
});
