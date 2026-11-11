// 用途：在 Obsidian 内打开注释样式实验窗口，读取当前流程图但不修改笔记。
import { Component, MarkdownRenderer, Modal, Notice, Plugin } from 'obsidian';
import { findMermaidBlocks } from './flowchart';
import { createPlayground } from './playground';

class StylePreviewModal extends Modal {
  private cleanup?: () => void;
  constructor(plugin: Plugin, private source: string, private sourcePath: string) { super(plugin.app); }
  onOpen() {
    this.modalEl.classList.add('mp-modal');
    const view = createPlayground(this.contentEl, this.source, async (source, target) => {
      const component = new Component(); component.load();
      // 选择不会被草稿中的反引号提前关闭的围栏。
      const longest = Math.max(2, ...[...source.matchAll(/`+/g)].map(m => m[0].length));
      const fence = '`'.repeat(longest + 1);
      try {
        await MarkdownRenderer.render(this.app, `${fence}mermaid\n${source}\n${fence}`, target, this.sourcePath, component);
        return () => component.unload();
      } catch (error) { component.unload(); throw error; }
    });
    this.cleanup = view.dispose;
  }
  onClose() { this.cleanup?.(); }
}

export default class MermaidPlus extends Plugin {
  async onload() {
    this.addCommand({
      id: 'preview-comment-styles', name: '预览 Mermaid 注释样式（实验）',
      editorCallback: (editor, context) => {
        const cursor = editor.getCursor().line;
        const block = findMermaidBlocks(editor.getValue()).find(b => b.start <= cursor && cursor <= b.end);
        if (!block) { new Notice('请将光标放在 Mermaid 代码块内。'); return; }
        new StylePreviewModal(this, block.source, context.file?.path ?? '').open();
      },
    });
  }
}
