// 用途：在 Obsidian 阅读视图和实时预览的 Mermaid 图上挂“编辑”入口，把可视化编辑写回笔记，并处理撤销与冲突。
import { MarkdownRenderChild, Notice, TFile, editorInfoField, type MarkdownPostProcessorContext, type Plugin } from 'obsidian';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { mountBlockEditor, type BlockEditor, type EditHost, type EditorState } from './blockEditor';
import { findMermaidBlocks, parseFlowchart } from './flowchart';
import { blockChange, locate } from './writeBack';
import { isFlowchartSource, renderMermaid, type RenderSettings } from './mermaidRender';

/** 一个代码块的位置：笔记路径 + 开头围栏所在行（从 0 开始）。 */
interface BlockRef { path: string; line: number }

/** 当前正在编辑的代码块。宿主界面因写回而重建后，据此自动恢复编辑状态。 */
interface Session extends BlockRef { state: EditorState; undo: [string, string][]; redo: [string, string][] }

/** 是流程图就显示“编辑”按钮；能否编辑在点击时再检查，并告诉用户具体原因。 */
const isFlowchart = isFlowchartSource;

/** 无法编辑时返回原因。 */
function problem(source: string): string | null {
  try { parseFlowchart(source); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

function explain(reason: string) {
  new Notice(`这张图暂时不能可视化编辑，请直接改源码。\n原因：${reason}`, 10000);
}

export class InlineEditing {
  private session?: Session;
  private mounted = new Map<HTMLElement, BlockEditor>();
  /** 实时预览里找到流程图块时调用，用来换成插件自己的渲染。 */
  onLiveEmbed?: (embed: HTMLElement, source: string) => void;
  /** 退出编辑后调用：编辑期间不画只读图，这时按最新源码补画。 */
  onExit?: (host: HTMLElement, source: string) => void;

  constructor(private plugin: Plugin, private settings: () => RenderSettings) {}

  register() {
    const self = this;
    this.plugin.registerEditorExtension(ViewPlugin.fromClass(class {
      private observer: MutationObserver;
      private timer = 0;
      private pending = false;
      constructor(private view: EditorView) {
        this.observer = new MutationObserver(records => {
          // 插件自己的编辑页和图在变时不用处理。
          const relevant = records.filter(r => !(r.target as Element).closest?.('.mp-block-editor, .mp-diagram-svg'));
          if (!relevant.length) return;
          // 代码块被 Obsidian 重建时立即处理（赶在浏览器画下一帧之前），否则原图会闪一下、编辑页会消失再出现。
          const embedChanged = relevant.some(r => [...r.addedNodes].some(n => n instanceof HTMLElement && (n.matches('.cm-embed-block') || !!n.querySelector('.cm-embed-block') || !!n.closest('.cm-embed-block'))));
          if (embedChanged) this.now(); else this.schedule();
        });
        this.observer.observe(view.contentDOM, { childList: true, subtree: true });
        this.schedule();
      }
      update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.schedule(); }
      destroy() { this.observer.disconnect(); window.clearTimeout(this.timer); }
      private schedule() { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => self.live(this.view), 60); }
      private now() {
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => { this.pending = false; window.clearTimeout(this.timer); self.live(this.view); });
      }
    }));
    this.plugin.register(() => { for (const editor of this.mounted.values()) editor.dispose(); this.mounted.clear(); });
  }

  /** 命令入口：编辑光标所在的 Mermaid 图。把光标移出代码块，实时预览才会显示图本身。 */
  editAtCursor(view: EditorView, path: string, cursorLine: number) {
    const block = findMermaidBlocks(view.state.doc.toString()).find(b => b.start <= cursorLine && cursorLine <= b.end);
    if (!block) { new Notice('请将光标放在 Mermaid 代码块内。'); return; }
    const reason = problem(block.source);
    if (reason) { explain(reason); return; }
    this.session = { path, line: block.start, state: {}, undo: [], redo: [] };
    const doc = view.state.doc;
    const after = block.end + 1 < doc.lines ? doc.line(block.end + 2).from : doc.line(block.end + 1).to;
    view.dispatch({ selection: { anchor: after }, scrollIntoView: true });
    this.schedule(view);
  }

  private schedule(view: EditorView) { window.setTimeout(() => this.live(view), 60); }

  /** 清掉已离开页面的编辑页；正在编辑的那个留着，等 Obsidian 重建好代码块后搬过去。 */
  private sweep() {
    for (const [host, editor] of this.mounted) if (!host.isConnected && !this.session) { editor.dispose(); this.mounted.delete(host); }
  }

  /** 结束一个编辑页，并让只读图按最新源码补画。 */
  private release(host: HTMLElement, editor: BlockEditor) {
    const source = editor.source();
    editor.dispose(); this.mounted.delete(host); host.classList.remove('mp-editing');
    if (host.isConnected) this.onExit?.(host, source);
  }

  /**
   * 代码块被 Obsidian 重建（写回、重新渲染）后，把正在编辑的编辑页原样搬进新容器，不重新渲染。
   * 按代码块位置或源码内容认领；只从已离开页面的、或同一窗格里的旧容器搬，避免在两个窗格之间抢。
   */
  claim(host: HTMLElement, path: string, line?: number, source?: string): boolean {
    const s = this.session;
    if (!s || s.path !== path) return false;
    const pane = (el: Element) => el.closest('.workspace-leaf-content');
    const same = (a: string, b: string) => a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
    for (const [old, editor] of this.mounted) {
      if (old === host) return true;
      if (old.isConnected && pane(old) !== pane(host)) continue;
      if (line !== s.line && !(source !== undefined && same(source, editor.source()))) continue;
      this.mounted.delete(old); old.classList.remove('mp-editing');
      host.classList.add('mp-edit-host', 'mp-editing');
      editor.adopt(host);
      this.mounted.set(host, editor);
      if (line !== undefined) s.line = line;
      if (source !== undefined && !same(source, editor.source())) editor.update(source);
      return true;
    }
    return false;
  }

  /** 设置改变后，按新样式重画正在打开的编辑页（保留选中）。 */
  refresh() { for (const editor of this.mounted.values()) editor.update(editor.source()); }

  /** 这个容器里正在显示编辑页。 */
  isEditing(host: HTMLElement) { return this.mounted.has(host); }

  /** 阅读视图：图画好后调用。通过 getSectionInfo 找到代码块，写回用 vault.process。实时预览里的图交给 live() 处理。 */
  attach(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    window.setTimeout(() => {
      if (!el.isConnected || el.closest('.cm-editor')) return;
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      const block = findMermaidBlocks(info.text).find(b => b.start === info.lineStart);
      if (!block || !isFlowchart(block.source)) return;
      const ref: BlockRef = { path: ctx.sourcePath, line: info.lineStart };
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      child.register(() => { this.mounted.get(el)?.dispose(); this.mounted.delete(el); });
      this.decorate(el, ref, () => this.readingHost(ref), button => this.toggleSource(el, ref, button));
    }, 0);
  }

  /** 实时预览：在编辑器里找到已渲染的代码块，按 DOM 位置反查源码行。 */
  private live(view: EditorView) {
    this.sweep();
    const file = view.state.field(editorInfoField, false)?.file;
    if (!file) return;
    const blocks = findMermaidBlocks(view.state.doc.toString());
    if (!blocks.length) return;
    for (const embed of view.contentDOM.querySelectorAll<HTMLElement>('.cm-embed-block')) {
      let line: number;
      try { line = view.state.doc.lineAt(view.posAtDOM(embed)).number - 1; } catch { continue; }
      const block = blocks.find(b => line >= b.start && line <= b.end) ?? blocks.find(b => Math.abs(b.start - line) <= 1);
      if (!block || !isFlowchart(block.source)) continue;
      const ref: BlockRef = { path: file.path, line: block.start };
      this.claim(embed, file.path, block.start, block.source);
      this.onLiveEmbed?.(embed, block.source);
      this.decorate(embed, ref, () => this.liveHost(view, ref), () => this.revealSource(view, ref));
    }
  }

  /** 给图加“源码 / 编辑”工具条；如果它正是当前会话的代码块，直接恢复编辑。 */
  private decorate(host: HTMLElement, ref: BlockRef, makeHost: () => EditHost & { read(): Promise<string | null> }, showSource: (button: HTMLButtonElement) => void) {
    host.classList.add('mp-edit-host');
    if (!host.querySelector(':scope > .mp-entry-bar')) {
      const doc = host.ownerDocument;
      const bar = doc.createElement('div');
      bar.className = 'mp-entry-bar';
      bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '流程图操作');
      // 阻止点击传到实时预览，否则光标会跳进代码块、图被源码替换。
      bar.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
      const button = (label: string, title: string, action: (b: HTMLButtonElement) => void) => {
        const b = doc.createElement('button');
        b.type = 'button'; b.className = 'mp-entry-button'; b.textContent = label; b.setAttribute('aria-label', title);
        b.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(b); });
        bar.append(b);
      };
      button('源码', '显示这张图的 Mermaid 源码', showSource);
      button('编辑', '可视化编辑这张流程图', () => {
        this.session = { ...ref, state: {}, undo: [], redo: [] };
        void this.open(host, ref, makeHost());
      });
      host.append(bar);
    }
    const existing = this.mounted.get(host);
    if (existing) {
      // 宿主容器被复用、但内容被 Obsidian 重新渲染时，编辑页会被挤掉，原样放回即可。
      if (!host.querySelector(':scope > .mp-block-editor')) existing.adopt(host);
      return;
    }
    const s = this.session;
    if (s && s.path === ref.path && s.line === ref.line) void this.open(host, ref, makeHost());
  }

  /** 实时预览：把光标放到代码块第一行，Obsidian 随即显示源码。 */
  private revealSource(view: EditorView, ref: BlockRef) {
    const block = findMermaidBlocks(view.state.doc.toString()).find(b => b.start === ref.line);
    if (!block) { new Notice('找不到这张图的源码，可能已被移动或修改。'); return; }
    const line = view.state.doc.line(Math.min(block.start + 2, block.end + 1));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  }

  /** 阅读视图：在图下方展开 / 收起只读源码。 */
  private toggleSource(host: HTMLElement, ref: BlockRef, button: HTMLButtonElement) {
    const shown = host.querySelector(':scope > .mp-source-view');
    if (shown) { shown.remove(); button.textContent = '源码'; return; }
    void this.readingHost(ref).read().then(source => {
      if (source === null) { new Notice('找不到这张图的源码，可能已被移动或修改。'); return; }
      if (host.querySelector(':scope > .mp-source-view')) return;
      const pre = host.ownerDocument.createElement('pre');
      pre.className = 'mp-source-view';
      const code = host.ownerDocument.createElement('code');
      code.textContent = source; pre.append(code); host.append(pre);
      button.textContent = '收起源码';
    });
  }

  private async open(host: HTMLElement, ref: BlockRef, editHost: EditHost & { read(): Promise<string | null> }) {
    if (this.mounted.has(host)) return;
    const source = await editHost.read();
    if (source === null) { new Notice('找不到这张图的源码，可能已被移动或修改。'); this.session = undefined; return; }
    const reason = problem(source);
    if (reason) { explain(reason); this.session = undefined; return; }
    if (this.mounted.has(host) || !host.isConnected) return;
    for (const [other, editor] of this.mounted) if (other !== host) this.release(other, editor);
    host.classList.add('mp-editing');
    const state = this.session && this.session.path === ref.path && this.session.line === ref.line ? this.session.state : {};
    this.mounted.set(host, mountBlockEditor(host, source, editHost, state));
  }

  private close(ref: BlockRef) {
    if (this.session && this.session.path === ref.path && this.session.line === ref.line) this.session = undefined;
    for (const [host, editor] of this.mounted) this.release(host, editor);
  }

  /** 编辑页与阅读视图用同一个渲染器和同一套样式。 */
  private async draw(source: string, target: HTMLElement) {
    await renderMermaid(source, target, this.settings());
  }

  private current(ref: BlockRef): Session | undefined {
    const s = this.session;
    return s && s.path === ref.path && s.line === ref.line ? s : undefined;
  }

  /** 阅读视图的写回：原子地读改写整篇笔记，撤销记录由插件保存。 */
  private readingHost(ref: BlockRef) {
    const app = this.plugin.app;
    const file = () => { const f = app.vault.getAbstractFileByPath(ref.path); return f instanceof TFile ? f : null; };
    const replace = async (before: string, after: string) => {
      const target = file();
      if (!target) return false;
      let ok = false;
      await app.vault.process(target, data => {
        const change = blockChange(data, ref.line, before, after);
        if (!change) return data;
        ok = true;
        return data.slice(0, change.from) + change.insert + data.slice(change.to);
      });
      return ok;
    };
    return {
      draw: (source: string, target: HTMLElement) => this.draw(source, target),
      read: async () => { const f = file(); return f ? locate(await app.vault.read(f), ref.line)?.source ?? null : null; },
      commit: async (before: string, after: string) => {
        const ok = await replace(before, after);
        const s = this.current(ref);
        if (ok && s) { s.undo.push([before, after]); s.redo.length = 0; }
        return ok;
      },
      undo: async () => {
        const s = this.current(ref), step = s?.undo.at(-1);
        if (!s || !step) return null;
        if (!await replace(step[1], step[0])) { new Notice('代码块已在别处修改，无法撤销。'); return null; }
        s.undo.pop(); s.redo.push(step); return step[0];
      },
      redo: async () => {
        const s = this.current(ref), step = s?.redo.at(-1);
        if (!s || !step) return null;
        if (!await replace(step[0], step[1])) { new Notice('代码块已在别处修改，无法重做。'); return null; }
        s.redo.pop(); s.undo.push(step); return step[1];
      },
      remember: (state: EditorState) => { const s = this.current(ref); if (s) s.state = state; },
      exit: () => this.close(ref),
    };
  }

  /** 实时预览的写回：只替换改动的行，进入编辑器自身的撤销历史，Cmd+Z 可直接撤销。 */
  private liveHost(view: EditorView, ref: BlockRef) {
    const editor = () => view.state.field(editorInfoField, false)?.editor;
    const read = () => locate(view.state.doc.toString(), ref.line)?.source ?? null;
    const afterHistory = (kind: 'undo' | 'redo') => {
      const target = editor();
      if (!target) return null;
      target[kind]();
      return read();
    };
    return {
      draw: (source: string, target: HTMLElement) => this.draw(source, target),
      read: async () => read(),
      commit: async (before: string, after: string) => {
        // 编辑器内部统一用 \n 作换行。
        const change = blockChange(view.state.doc.toString(), ref.line, before, after);
        if (!change) return false;
        view.dispatch({ changes: change, userEvent: 'input.mermaid-plus' });
        return true;
      },
      undo: async () => afterHistory('undo'),
      redo: async () => afterHistory('redo'),
      remember: (state: EditorState) => { const s = this.current(ref); if (s) s.state = state; },
      exit: () => this.close(ref),
    };
  }
}
