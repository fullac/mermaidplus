// 用途：插件自带的 Mermaid 渲染器。阅读视图、实时预览和编辑页都用它，保证三处外观一致；样式（主题、紧凑程度、字体）由插件设置决定。
import type { Mermaid } from 'mermaid';

/** Mermaid 体积很大，第一次真正要画流程图时才初始化，插件启动不再为它付出时间。 */
let loading: Promise<Mermaid> | undefined;
export function loadBundledMermaid() {
  return loading ??= import('mermaid').then(m => m.default);
}
/** ELK 参数调整和 Mermaid 一样，第一次画图时才加载。 */
let tuningModule: Promise<typeof import('./elkTuning')> | undefined;
/** 手动位置也只在源码里有位置注释时才加载。 */
let layoutModule: Promise<[typeof import('./manualLayout'), typeof import('./flowchart')]> | undefined;
/** 连线避让文字。 */
let avoidModule: Promise<typeof import('./edgeAvoid')> | undefined;

export type Density = 'compact' | 'normal' | 'loose';
export type ThemeChoice = 'auto' | 'default' | 'neutral' | 'forest' | 'dark' | 'base';

export interface RenderSettings {
  theme: ThemeChoice;
  density: Density;
  /** 留空表示使用 Mermaid 默认字体。 */
  fontFamily: string;
  fontSize: number;
  /** orthogonal：只走水平和垂直线（Mermaid 自带的 ELK 排版）；curved：Mermaid 默认的 dagre 排版加平滑曲线。 */
  edges: 'orthogonal' | 'curved';
  /** 直角走线时，连线交叉处画成小半圆跳线（arc）、断开（gap）或直接交叉（none）。 */
  hops: 'arc' | 'gap' | 'none';
  /** 竖排：不管源码写的方向，整张图一律自上而下。 */
  vertical: boolean;
  /** 自动选横竖：直角走线时两个方向各排一次，选放进笔记栏后更合适的；竖排开启时不起作用。 */
  autoDirection: boolean;
  /** 图的背景色（CSS 颜色）；留空表示透明，跟随笔记背景。 */
  background: string;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = { theme: 'default', density: 'compact', fontFamily: '', fontSize: 14, edges: 'curved', hops: 'arc', vertical: false, autoDirection: false, background: '#fafafa' };

/** 节点间距、层间距、节点内边距、整图留白。宽松即 Mermaid 默认值。 */
export const DENSITY: Record<Density, { nodeSpacing: number; rankSpacing: number; padding: number; diagramPadding: number }> = {
  compact: { nodeSpacing: 30, rankSpacing: 44, padding: 8, diagramPadding: 4 },
  normal: { nodeSpacing: 40, rankSpacing: 48, padding: 12, diagramPadding: 8 },
  loose: { nodeSpacing: 50, rankSpacing: 50, padding: 15, diagramPadding: 8 },
};

const MERMAID_FONT = '"trebuchet ms", verdana, arial, sans-serif';

function resolveTheme(choice: ThemeChoice, doc: Document) {
  if (choice !== 'auto') return choice;
  return doc.body?.classList.contains('theme-dark') ? 'dark' : 'default';
}

let serial = 0;
/** Mermaid 的配置是全局的，渲染逐个排队，避免互相覆盖配置。 */
let queue: Promise<unknown> = Promise.resolve();

/** 把源码渲染成 SVG 放进 target，返回 svg 元素。出错时抛出 Mermaid 的错误信息。 */
export function renderMermaid(source: string, target: HTMLElement, settings: RenderSettings = DEFAULT_RENDER_SETTINGS): Promise<SVGSVGElement> {
  const run = async () => {
    const doc = target.ownerDocument;
    const mermaid = await loadBundledMermaid();
    const orthogonal = settings.edges !== 'curved';
    const fontFamily = settings.fontFamily.trim() || MERMAID_FONT;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: resolveTheme(settings.theme, doc),
      fontFamily,
      themeVariables: { fontFamily, fontSize: `${settings.fontSize}px` },
      flowchart: { ...DENSITY[settings.density], curve: orthogonal ? 'linear' : 'basis', htmlLabels: true, useMaxWidth: true, wrappingWidth: 260,
        // 给子图标题留出位置，避免嵌套子图的标题互相重叠。
        subGraphTitleMargin: { top: 6, bottom: 6 } },
      markdownAutoWrap: true,
      layout: orthogonal ? 'elk' : 'dagre',
      elk: { lineHops: settings.hops === 'none' ? false : settings.hops },
    });
    const id = `mp-diagram-${Date.now().toString(36)}-${++serial}`;
    try {
      const text = settings.vertical ? withVerticalHeader(source) : source;
      const tuning = { density: settings.density, vertical: settings.vertical, autoDirection: settings.autoDirection, availableWidth: availableWidth(target) };
      const { svg, bindFunctions } = await (await (tuningModule ??= import('./elkTuning'))).withElkTuning(tuning, () => mermaid.render(id, text));
      // strict 模式下 Mermaid 已清理用户标签中的 HTML；这里按 HTML 解析以兼容其中的 <br> 等写法，只取出 svg 元素。
      const parsed = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
      if (!parsed) throw new Error('Mermaid 没有生成图。');
      const element = doc.importNode(parsed, true) as unknown as SVGSVGElement;
      element.dataset.mpEdges = orthogonal ? 'orthogonal' : 'curved';
      const background = settings.background.trim();
      if (background) { element.style.backgroundColor = background; element.style.borderRadius = '6px'; }
      if (source.includes('%% mermaid-plus-layout:')) await applyStoredLayout(source, element, target);
      // 压到文字的连线绕开；连线画在节点之上，连线文字在最上层。只读 SVG 属性，不需要先放进页面。
      const { avoidText, edgesOnTop } = await (avoidModule ??= import('./edgeAvoid'));
      try { avoidText(element); } catch { /* 避让失败时保留 Mermaid 原来的连线 */ }
      edgesOnTop(element);
      target.replaceChildren(element);
      bindFunctions?.(element);
      return element;
    } finally {
      // 渲染失败时 Mermaid 会在页面上留下临时元素。
      doc.getElementById(`d${id}`)?.remove();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** 按源码里的位置注释移动节点。移动要量尺寸，目标还没放进页面时先在页面外的临时容器里量。 */
async function applyStoredLayout(source: string, element: SVGSVGElement, target: HTMLElement) {
  const [{ readLayout, applyManualLayout }, { parseFlowchart }] = await (layoutModule ??= Promise.all([import('./manualLayout'), import('./flowchart')]));
  const layout = readLayout(source);
  if (!Object.keys(layout.nodes).length) return;
  let chart;
  try { chart = parseFlowchart(source); } catch { return; } // 插件解析不了的写法只显示自动排版。
  const doc = target.ownerDocument;
  const holder = target.isConnected ? target : doc.body.appendChild(doc.createElement('div'));
  if (holder !== target) Object.assign(holder.style, { position: 'absolute', left: '-20000px', top: '0', visibility: 'hidden', width: `${availableWidth(target)}px` });
  holder.replaceChildren(element);
  try { applyManualLayout(element, chart, layout); }
  finally { if (holder !== target) holder.remove(); }
}

/** 图能占用的宽度：目标元素或其上层第一个有宽度的元素；都量不到时按常见笔记栏宽度估计。 */
function availableWidth(target: HTMLElement) {
  for (let el: HTMLElement | null = target; el; el = el.parentElement) if (el.clientWidth > 0) return el.clientWidth;
  return 700;
}

/** 把 flowchart / graph 首行的方向改成 TD（没写方向就补上）。只改渲染用的副本，不改笔记。 */
export function withVerticalHeader(source: string) {
  const lines = source.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') { i = 1; while (i < lines.length && lines[i]!.trim() !== '---') i++; i++; }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('%%')) continue;
    lines[i] = line.replace(/^(\s*(?:flowchart|graph))(?:[ \t]+(?:TB|TD|BT|LR|RL))?(?=[\s;]|$)/, '$1 TD');
    break;
  }
  return lines.join('\n');
}

/** 第一行（跳过注释和 front matter）是 flowchart / graph 时返回 true。 */
export function isFlowchartSource(source: string) {
  const lines = source.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') { i = 1; while (i < lines.length && lines[i]!.trim() !== '---') i++; i++; }
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('%%')) continue;
    return /^(flowchart|graph)\b/.test(line);
  }
  return false;
}
