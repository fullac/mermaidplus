// 用途：插件自带的 Mermaid 渲染器。阅读视图、实时预览和编辑页都用它，保证三处外观一致；样式（主题、紧凑程度、字体）由插件设置决定。
import type { Mermaid } from 'mermaid';

/** Mermaid 体积很大，第一次真正要画流程图时才初始化，插件启动不再为它付出时间。 */
let loading: Promise<Mermaid> | undefined;
export function loadBundledMermaid() {
  return loading ??= import('mermaid').then(m => m.default);
}

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
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = { theme: 'auto', density: 'compact', fontFamily: '', fontSize: 14, edges: 'orthogonal', hops: 'arc' };

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
      const { svg, bindFunctions } = await mermaid.render(id, source);
      // strict 模式下 Mermaid 已清理用户标签中的 HTML；这里按 HTML 解析以兼容其中的 <br> 等写法，只取出 svg 元素。
      const parsed = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
      if (!parsed) throw new Error('Mermaid 没有生成图。');
      const element = doc.importNode(parsed, true) as unknown as SVGSVGElement;
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
