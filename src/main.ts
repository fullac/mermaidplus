// 用途：插件入口——用插件自带的渲染器和样式画流程图，在图上原位可视化编辑并写回笔记；提供样式设置。
import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { InlineEditing } from './obsidianEdit';
import { DiagramBlocks } from './obsidianRender';
import { DEFAULT_RENDER_SETTINGS, type Density, type RenderSettings, type ThemeChoice } from './mermaidRender';

class StyleSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MermaidPlus) { super(app, plugin); }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = (change: Partial<RenderSettings>) => this.plugin.updateSettings(change);
    new Setting(containerEl).setName('配色主题').setDesc('“跟随明暗”在浅色模式用 Mermaid 默认主题，深色模式用暗色主题。')
      .addDropdown(d => d.addOptions({ auto: '跟随明暗', default: '默认', neutral: '中性', forest: '森林', dark: '暗色', base: '基础' })
        .setValue(s.theme).onChange(v => save({ theme: v as ThemeChoice })));
    new Setting(containerEl).setName('紧凑程度').setDesc('节点间距、层间距和节点内边距。宽松即 Mermaid 默认值。')
      .addDropdown(d => d.addOptions({ compact: '紧凑', normal: '适中', loose: '宽松' })
        .setValue(s.density).onChange(v => save({ density: v as Density })));
    new Setting(containerEl).setName('字体').setDesc('CSS 字体名，可写多个用逗号分隔；留空使用 Mermaid 默认字体。例如：var(--font-interface)')
      .addText(t => t.setPlaceholder('"trebuchet ms", verdana, arial, sans-serif').setValue(s.fontFamily)
        .onChange(v => save({ fontFamily: v })));
    new Setting(containerEl).setName('字号').setDesc('单位 px。')
      .addSlider(sl => sl.setLimits(10, 22, 1).setValue(s.fontSize).setDynamicTooltip().onChange(v => save({ fontSize: v })));
    new Setting(containerEl).setName('连线').setDesc('直角走线只有水平和垂直线，用 Mermaid 自带的 ELK 排版；平滑曲线是 Mermaid 默认外观，排得更紧凑。')
      .addDropdown(d => d.addOptions({ orthogonal: '直角走线', curved: '平滑曲线' })
        .setValue(s.edges).onChange(v => save({ edges: v as RenderSettings['edges'] })));
    new Setting(containerEl).setName('连线交叉处').setDesc('仅直角走线有效。')
      .addDropdown(d => d.addOptions({ arc: '跳线（半圆绕过）', gap: '断开', none: '直接交叉' })
        .setValue(s.hops).onChange(v => save({ hops: v as RenderSettings['hops'] })));
  }
}

export default class MermaidPlus extends Plugin {
  settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };
  private blocks?: DiagramBlocks;
  private repaintTimer = 0;

  async onload() {
    const saved = (await this.loadData()) ?? {};
    // 旧版本的“排版 / 连线拐弯”两项已合并为“连线”。
    delete saved.layout; delete saved.curve;
    this.settings = { ...DEFAULT_RENDER_SETTINGS, ...saved };
    const editing = new InlineEditing(this, () => this.settings);
    editing.register();
    this.blocks = new DiagramBlocks(this, () => this.settings, editing);
    this.blocks.register();
    this.addSettingTab(new StyleSettingTab(this.app, this));
    // 切换明暗模式时，“跟随明暗”的图需要重画。
    this.registerEvent(this.app.workspace.on('css-change', () => { if (this.settings.theme === 'auto') this.scheduleRepaint(); }));
    this.addCommand({
      id: 'edit-flowchart', name: '编辑光标所在的 Mermaid 流程图',
      editorCallback: (editor, context) => {
        // Obsidian 的 Editor 在实时预览下带有 CodeMirror 视图（cm），这是官方插件常用的取法。
        const view = (editor as unknown as { cm?: EditorView }).cm;
        if (!view || !context.file) { new Notice('请在实时预览模式下使用此命令，或在阅读视图中点击图右上角的“编辑”。'); return; }
        editing.editAtCursor(view, context.file.path, editor.getCursor().line);
      },
    });
  }

  onunload() { window.clearTimeout(this.repaintTimer); }

  async updateSettings(change: Partial<RenderSettings>) {
    this.settings = { ...this.settings, ...change };
    await this.saveData(this.settings);
    this.scheduleRepaint();
  }

  private scheduleRepaint() {
    window.clearTimeout(this.repaintTimer);
    this.repaintTimer = window.setTimeout(() => void this.blocks?.repaint(), 250);
  }
}
