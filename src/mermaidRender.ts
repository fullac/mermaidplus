// 用途：插件自带的 Mermaid 渲染器，负责流程图和时序图。阅读视图、实时预览和编辑页都用它，保证三处外观一致；样式（主题、紧凑程度、字体）由插件设置决定。
import type { Mermaid } from 'mermaid';
import { markCanvasTone } from './canvasTone';

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

/** 时序图的间距：参与者之间、消息之间、方框和注释的留白、参与者框高度。宽松即 Mermaid 默认值（画布留白与流程图一致）。 */
export const SEQUENCE_DENSITY: Record<Density, { actorMargin: number; messageMargin: number; boxMargin: number; noteMargin: number; height: number }> = {
  compact: { actorMargin: 30, messageMargin: 26, boxMargin: 6, noteMargin: 6, height: 44 },
  normal: { actorMargin: 40, messageMargin: 30, boxMargin: 8, noteMargin: 8, height: 54 },
  loose: { actorMargin: 50, messageMargin: 35, boxMargin: 10, noteMargin: 10, height: 65 },
};

const MERMAID_FONT = '"trebuchet ms", verdana, arial, sans-serif';
/** 阅读视图里宽图的最小显示比例。和方向评分用的 MIN_READABLE_SCALE 分开，改其中一个不影响另一个。 */
export const MIN_DISPLAY_SCALE = 0.65;

function resolveTheme(choice: ThemeChoice, doc: Document) {
  if (choice !== 'auto') return choice;
  return doc.body?.classList.contains('theme-dark') ? 'dark' : 'default';
}

let serial = 0;
/** Mermaid 的配置是全局的，渲染逐个排队，避免互相覆盖配置。 */
let queue: Promise<unknown> = Promise.resolve();
const targetRevision = new WeakMap<HTMLElement, number>();

/** 把源码渲染成 SVG 放进 target，返回 svg 元素。出错时抛出 Mermaid 的错误信息；请求已被更新的渲染取代时返回 null。 */
export function renderMermaid(source: string, target: HTMLElement, settings: RenderSettings = DEFAULT_RENDER_SETTINGS): Promise<SVGSVGElement | null> {
  const revision = (targetRevision.get(target) ?? 0) + 1;
  targetRevision.set(target, revision);
  // 复制配置，避免等待全局渲染队列期间被设置面板修改。
  settings = { ...settings };
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
      // 时序图按顶层 fontSize 统一各处字号，不设会用 Mermaid 默认的 16px。
      fontSize: settings.fontSize,
      themeVariables: { fontFamily, fontSize: `${settings.fontSize}px` },
      // 时序图：间距按紧凑程度，字体字号与流程图一致；直角走线开启时，发给自己的消息也画成直角。
      sequence: { ...SEQUENCE_DENSITY[settings.density], diagramMarginX: DENSITY[settings.density].diagramPadding, diagramMarginY: DENSITY[settings.density].diagramPadding, useMaxWidth: true, rightAngles: orthogonal,
        actorFontFamily: fontFamily, messageFontFamily: fontFamily, noteFontFamily: fontFamily, actorFontSize: settings.fontSize, messageFontSize: settings.fontSize, noteFontSize: settings.fontSize },
      flowchart: { ...DENSITY[settings.density], curve: orthogonal ? 'linear' : 'basis', htmlLabels: true, useMaxWidth: true, wrappingWidth: 260,
        // 给子图标题留出位置，避免嵌套子图的标题互相重叠。
        subGraphTitleMargin: { top: 6, bottom: 6 } },
      markdownAutoWrap: true,
      layout: orthogonal ? 'elk' : 'dagre',
      elk: { lineHops: settings.hops === 'none' ? false : settings.hops },
    });
    const id = `mp-diagram-${Date.now().toString(36)}-${++serial}`;
    const renderHost = stagingHost(doc, target);
    try {
      const flowchart = isFlowchartSource(source);
      let rendered;
      if (flowchart) {
        const text = settings.vertical ? withVerticalHeader(source) : source;
        const tuning = { density: settings.density, vertical: settings.vertical, autoDirection: settings.autoDirection, availableWidth: availableWidth(target) };
        rendered = await (await (tuningModule ??= import('./elkTuning'))).withElkTuning(tuning, () => mermaid.render(id, text, renderHost));
      } else rendered = await mermaid.render(id, source, renderHost);
      const { svg, bindFunctions } = rendered;
      // strict 模式下 Mermaid 已清理用户标签中的 HTML；这里按 HTML 解析以兼容其中的 <br> 等写法，只取出 svg 元素。
      const parsed = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
      if (!parsed) throw new Error('Mermaid 没有生成图。');
      const element = doc.importNode(parsed, true) as unknown as SVGSVGElement;
      element.dataset.mpEdges = orthogonal ? 'orthogonal' : 'curved';
      element.dataset.mpHops = settings.hops;
      const background = settings.background.trim();
      element.dataset.mpBackground = background;
      // Mermaid 自身可能写入主题底色；整栏背景统一交给外层。
      element.style.backgroundColor = 'transparent';
      if (flowchart) {
        if (source.includes('%% mermaid-plus-layout:')) await applyStoredLayout(source, element, target);
        // 压到文字的连线绕开；连线画在节点之上，连线文字在最上层。只读 SVG 属性，不需要先放进页面。
        const { avoidText, edgesOnTop, applyLineHops } = await (avoidModule ??= import('./edgeAvoid'));
        try { avoidText(element); applyLineHops(element); } catch { /* 避让失败时保留 Mermaid 原来的连线 */ }
        edgesOnTop(element);
        const viewWidth = Number(element.getAttribute('viewBox')?.split(/[\s,]+/)[2]);
        if (viewWidth > 0) {
          element.dataset.mpMinScale = String(MIN_DISPLAY_SCALE);
          element.style.minWidth = `${viewWidth * MIN_DISPLAY_SCALE}px`;
        }
      }
      bindFunctions?.(element);
      // 旧任务可以完成计算，但不能覆盖同一容器的新请求。
      if (targetRevision.get(target) === revision) {
        target.classList.add('mp-diagram-surface');
        target.style.backgroundColor = background;
        markCanvasTone(target, { theme: resolveTheme(settings.theme, doc), background });
        target.replaceChildren(element);
      }
      return element;
    } catch (error) {
      // 已过期任务的错误也不能让宿主把新画面换成错误提示。
      if (targetRevision.get(target) !== revision) return null;
      throw error;
    } finally {
      renderHost.remove();
      // 渲染失败时 Mermaid 会在页面上留下临时元素。
      doc.getElementById(`d${id}`)?.remove();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** 离屏测量容器：渲染和套用位置注释都用它，宽度取目标所在栏。 */
function stagingHost(doc: Document, target: HTMLElement): HTMLElement {
  const host = doc.body.appendChild(doc.createElement('div'));
  host.className = 'mp-render-staging';
  Object.assign(host.style, { position: 'absolute', left: '-20000px', top: '0', visibility: 'hidden', width: `${availableWidth(target)}px` });
  return host;
}

/** 按源码里的位置注释移动节点。移动要量尺寸，目标还没放进页面时先在页面外的临时容器里量。 */
async function applyStoredLayout(source: string, element: SVGSVGElement, target: HTMLElement) {
  const [{ readLayout, applyManualLayout }, { parseFlowchart }] = await (layoutModule ??= Promise.all([import('./manualLayout'), import('./flowchart')]));
  const layout = readLayout(source);
  if (!Object.keys(layout.nodes).length) return;
  let chart;
  try { chart = parseFlowchart(source); } catch { return; } // 插件解析不了的写法只显示自动排版。
  const holder = stagingHost(target.ownerDocument, target);
  holder.replaceChildren(element);
  try { applyManualLayout(element, chart, layout); }
  finally { holder.remove(); }
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

/** 图的类型：插件负责渲染的流程图和时序图，其余返回 undefined（仍由 Obsidian 自带的 Mermaid 显示）。只看第一行（跳过注释和 front matter）。 */
export function diagramKind(source: string): 'flowchart' | 'sequence' | undefined {
  const lines = source.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') { i = 1; while (i < lines.length && lines[i]!.trim() !== '---') i++; i++; }
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('%%')) continue;
    if (/^(flowchart|graph)\b/.test(line)) return 'flowchart';
    if (/^sequenceDiagram\b/.test(line)) return 'sequence';
    return undefined;
  }
  return undefined;
}

/** 是流程图（可以可视化编辑）。 */
export const isFlowchartSource = (source: string) => diagramKind(source) === 'flowchart';
/** 插件负责渲染（流程图或时序图）。 */
export const isPluginSource = (source: string) => diagramKind(source) !== undefined;
