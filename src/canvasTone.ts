// 用途：按画布实际亮度标记宿主，让源码/编辑按钮和编辑工具条跟画布走，而不是跟 Obsidian 窗口的明暗走。
import type { RenderSettings, ThemeChoice } from './mermaidRender';

export type CanvasTone = 'light' | 'dark';

/** 挂在图的宿主上。按钮和工具条读这个属性选浅色或深色配色。 */
export const CANVAS_TONE = 'data-mp-canvas';

/** 把 CSS 颜色换成相对亮度；认不出的颜色返回 undefined，交给主题判断。 */
export function relativeLuminance(color: string): number | undefined {
  const value = color.trim().toLowerCase();
  if (!value || value === 'transparent') return undefined;
  const hex = value.match(/^#([\da-f]{3,8})$/);
  let r = 0, g = 0, b = 0, a = 1;
  if (hex) {
    const raw = hex[1]!;
    const full = raw.length <= 4 ? [...raw].map(ch => ch + ch).join('') : raw;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
    if (full.length >= 8) a = parseInt(full.slice(6, 8), 16) / 255;
  } else {
    const fn = value.match(/^(rgba?|hsla?)\((.+)\)$/);
    if (!fn) return undefined;
    const parts = fn[2]!.replaceAll('/', ' ').split(/[\s,]+/).filter(Boolean).map(part => Number.parseFloat(part));
    if (parts.length < 3 || parts.slice(0, 3).some(n => Number.isNaN(n))) return undefined;
    if (fn[1]!.startsWith('rgb')) { [r, g, b] = parts as [number, number, number]; a = parts[3] ?? 1; }
    else {
      const [h, sPct, lPct] = parts as [number, number, number];
      const s = sPct / 100, l = lPct / 100;
      const chroma = (1 - Math.abs(2 * l - 1)) * s;
      const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
      const m = l - chroma / 2;
      const hue = ((h % 360) + 360) % 360;
      const seg = Math.floor(hue / 60);
      const rgb = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][seg]!;
      [r, g, b] = rgb.map(channel => (channel + m) * 255) as [number, number, number];
      a = parts[3] ?? 1;
    }
  }
  if (a < 0.5) return undefined;
  const lin = (channel: number) => { const n = channel / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; };
  return lin(r) * 0.2126 + lin(g) * 0.7152 + lin(b) * 0.0722;
}

/** 没有自定义底色时，浅色主题的画布是浅的，暗色主题的画布是深的。跟随明暗则看宿主窗口。 */
function themeTone(theme: ThemeChoice, doc: Document): CanvasTone {
  if (theme === 'dark') return 'dark';
  if (theme === 'auto') return doc.body?.classList.contains('theme-dark') ? 'dark' : 'light';
  return 'light';
}

/** 自定义底色按亮度；透明或认不出的颜色跟随已解析的主题。 */
export function canvasTone(settings: Pick<RenderSettings, 'theme' | 'background'>, doc: Document): CanvasTone {
  const luminance = relativeLuminance(settings.background);
  if (luminance === undefined) return themeTone(settings.theme, doc);
  return luminance > 0.4 ? 'light' : 'dark';
}

/** 渲染完成后标在宿主上，样式据此给按钮和工具条配色。 */
export function markCanvasTone(host: HTMLElement, settings: Pick<RenderSettings, 'theme' | 'background'>) {
  host.setAttribute(CANVAS_TONE, canvasTone(settings, host.ownerDocument));
}

/** 把画布上的明暗标记抄到带按钮的外层。画布没有标记时清掉，避免留下过期配色。 */
export function copyCanvasTone(from: HTMLElement, to: HTMLElement) {
  const tone = from.getAttribute(CANVAS_TONE);
  if (tone) to.setAttribute(CANVAS_TONE, tone);
  else to.removeAttribute(CANVAS_TONE);
}
