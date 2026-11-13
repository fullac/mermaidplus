// 用途：接管笔记中的 mermaid 代码块：流程图和时序图用插件自带的渲染器和样式画出，其余图类型仍用 Obsidian 自带的 Mermaid；设置变化时重画。
// Obsidian 自带 mermaid 渲染，插件通常无法再注册同名代码块处理器。因此另有两条兜底路径（只用公开接口和页面 DOM）：
//   阅读视图——用排序靠前的 Markdown 后处理器，在 Obsidian 画图前（或画完后）换成插件画的图；
//   实时预览——在编辑器里找到 Obsidian 画好的图块，隐藏原图，在旁边放插件画的图。
import { MarkdownRenderChild, loadMermaid, type App, type MarkdownPostProcessorContext, type Plugin } from 'obsidian';
import { findMermaidBlocks } from './flowchart';
import { copyCanvasTone } from './canvasTone';
import { isPluginSource, renderMermaid, type RenderSettings } from './mermaidRender';
import type { InlineEditing } from './obsidianEdit';

interface Drawn { el: HTMLElement; source: string }

let serial = 0;

/** 非流程图用 Obsidian 自己的 Mermaid（与未安装插件时相同）。 */
async function renderWithObsidian(source: string, target: HTMLElement) {
  const mermaid = await loadMermaid();
  const id = `mp-native-${++serial}`;
  try {
    const { svg } = await mermaid.render(id, source);
    const parsed = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
    if (parsed) target.replaceChildren(target.ownerDocument.importNode(parsed, true));
  } finally { target.ownerDocument.getElementById(`d${id}`)?.remove(); }
}

/** 插件自己加的元素，不当作 Obsidian 原图隐藏。 */
const OURS = ['mp-diagram-svg', 'mp-entry-bar', 'mp-source-view', 'mp-block-editor', 'edit-block-button'];

/** 插件插进页面的节点。 */
const INJECTED = '.mp-block-editor, .mp-diagram-svg, .mp-entry-bar, .mp-source-view';
/** 插件加在 Obsidian 元素上的 class。 */
const MARKS = ['mp-diagram', 'mp-edit-host', 'mp-editing', 'mp-native-hidden'];
/** 插件写在宿主上的明暗标记，卸载时去掉，避免残留配色。 */
const TONE = 'data-mp-canvas';

/** 图可能画在主窗口，也可能画在弹出窗口里，清理时都要找到。 */
function documentsOf(app: App): Document[] {
  const docs = new Set<Document>([document]);
  try {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) docs.add(leaf.view.containerEl.ownerDocument);
  } catch { /* 卸载早期窗口可能已经没了，主窗口仍要清理。 */ }
  return [...docs];
}

/**
 * 禁用插件时按清单撤掉注入的节点和 class。
 * 阅读视图里被删掉的原生图靠重画恢复（见 main.ts 的 restoreNativeDiagrams）。
 */
export function purgePluginDom(app: App) {
  for (const doc of documentsOf(app)) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(INJECTED))) el.remove();
    for (const mark of MARKS) for (const el of Array.from(doc.querySelectorAll<HTMLElement>(`.${mark}`))) el.classList.remove(mark);
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(`[${TONE}]`))) el.removeAttribute(TONE);
  }
}

export class DiagramBlocks {
  private drawn = new Set<Drawn>();
  private live = new WeakMap<HTMLElement, Drawn>();
  /** 阅读视图兜底用的观察器，禁用插件时要一起断开。 */
  private observers = new Set<MutationObserver>();
  /** 插件已被禁用：之后所有回调都必须立刻返回，不要再往页面上加东西。 */
  private disposed = false;

  constructor(private plugin: Plugin, private settings: () => RenderSettings, private editing: InlineEditing) {}

  register() {
    try {
      this.plugin.registerMarkdownCodeBlockProcessor('mermaid', (source, el, ctx) => this.process(source, el, ctx));
    } catch (error) {
      console.info('[Mermaid Plus] mermaid 代码块已被 Obsidian 占用，改用兜底方式接管流程图。', error);
    }
    // 无论上面是否成功都注册：若代码块处理器生效，页面上不会出现 Obsidian 原图，兜底逻辑什么都不做。
    this.plugin.registerMarkdownPostProcessor((el, ctx) => this.claimSection(el, ctx), -1000);
    this.editing.onLiveEmbed = (embed, source) => this.claimLive(embed, source);
    this.editing.onExit = (host, source) => {
      const entry = [...this.drawn].find(e => e.el === host);
      if (entry) { entry.source = source; void this.paint(entry); } else this.claimLive(host, source);
    };
    this.plugin.register(() => this.dispose());
  }

  /** 禁用插件时：断开观察器、丢掉记录、把注入的节点和 class 全部撤掉。重复调用无副作用。 */
  dispose() {
    this.disposed = true;
    for (const observer of this.observers) observer.disconnect();
    this.observers.clear();
    this.drawn.clear();
    this.live = new WeakMap();
    purgePluginDom(this.plugin.app);
  }

  private async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    if (this.disposed) return;
    el.classList.add('mp-diagram');
    const entry: Drawn = { el, source };
    this.drawn.add(entry);
    // 正在编辑的代码块被重建：直接把编辑页搬进来，不画只读图（退出编辑时再画）。
    if (this.editing.claim(el, ctx.sourcePath, undefined, source)) { this.editing.attach(el, ctx); return; }
    await this.paint(entry);
    if (isPluginSource(source)) this.editing.attach(el, ctx);
  }

  /** 阅读视图兜底：把这一段里的 mermaid 流程图、时序图换成插件画的图。Obsidian 若稍后才画完原图，再次清掉。 */
  private claimSection(section: HTMLElement, ctx: MarkdownPostProcessorContext) {
    if (this.disposed) return;
    const check = () => {
      if (this.disposed) return true;
      if (section.querySelector('.mp-diagram')) { this.dropNative(section); return true; }
      const code = section.querySelector<HTMLElement>('pre > code.language-mermaid');
      let source = code?.textContent ?? null;
      if (source === null) {
        if (!section.querySelector('.mermaid')) return false;
        const info = ctx.getSectionInfo(section);
        source = info ? findMermaidBlocks(info.text).find(b => b.start === info.lineStart)?.source ?? null : null;
      }
      if (source === null || !isPluginSource(source)) return source !== null;
      const host = section.ownerDocument.createElement('div');
      section.append(host);
      this.dropNative(section);
      void this.process(source.replace(/\n$/, ''), host, ctx);
      return true;
    };
    if (!section.querySelector('pre > code.language-mermaid, .mermaid')) return;
    check();
    // Obsidian 的原图可能在之后异步插入，观察一小段时间。
    const observer = new MutationObserver(() => check());
    observer.observe(section, { childList: true, subtree: true });
    this.observers.add(observer);
    const child = new MarkdownRenderChild(section);
    child.register(() => { observer.disconnect(); this.observers.delete(observer); });
    ctx.addChild(child);
  }

  /** 移除阅读视图中 Obsidian 生成的 mermaid 原图或原始代码块。 */
  private dropNative(section: HTMLElement) {
    for (const node of section.querySelectorAll<HTMLElement>('pre:has(> code.language-mermaid), .mermaid')) {
      if (!node.closest('.mp-diagram')) node.remove();
    }
  }

  /** 实时预览兜底：隐藏 Obsidian 画的原图，在同一个图块里放插件画的图。 */
  private claimLive(embed: HTMLElement, source: string) {
    if (this.disposed || embed.querySelector('.mp-diagram')) return;
    for (const child of Array.from(embed.children) as HTMLElement[]) {
      if (!OURS.some(name => child.classList.contains(name))) child.classList.add('mp-native-hidden');
    }
    // 编辑期间图被编辑页遮住，不必重画；退出编辑时由 onExit 补画。
    if (this.editing.isEditing(embed)) return;
    let entry = this.live.get(embed);
    if (entry && entry.source === source && embed.querySelector(':scope > .mp-diagram-svg')) return;
    if (!entry) { entry = { el: embed, source }; this.live.set(embed, entry); this.drawn.add(entry); }
    entry.source = source;
    void this.paint(entry);
  }

  private async paint({ el, source }: Drawn) {
    if (this.disposed) return;
    let holder = el.querySelector<HTMLElement>(':scope > .mp-diagram-svg');
    if (!holder) { holder = el.ownerDocument.createElement('div'); holder.className = 'mp-diagram-svg'; el.prepend(holder); }
    try {
      if (isPluginSource(source)) await renderMermaid(source, holder, this.settings());
      else await renderWithObsidian(source, holder);
      // 按钮挂在代码块上，明暗跟画布走，所以标记从内层图容器抄到代码块。
      copyCanvasTone(holder, el);
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      const pre = el.ownerDocument.createElement('pre');
      pre.className = 'mp-render-error'; pre.textContent = `Mermaid 渲染失败：${message}`;
      holder.replaceChildren(pre);
    }
  }

  /** 样式设置改变后重画所有仍在页面上的流程图和时序图。 */
  async repaint() {
    if (this.disposed) return;
    for (const entry of [...this.drawn]) {
      if (!entry.el.isConnected) { this.drawn.delete(entry); continue; }
      if (isPluginSource(entry.source)) await this.paint(entry);
    }
  }
}
