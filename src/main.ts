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
    // 改动后需要显示或隐藏相关选项的开关，保存后重画设置页。
    const saveAndRefresh = async (change: Partial<RenderSettings>) => { await save(change); this.display(); };

    new Setting(containerEl).setName('排版').setHeading();
    new Setting(containerEl).setName('竖排').setDesc('开启后所有流程图一律自上而下排列，不管源码写的是 LR 还是 TD。只影响显示，不改笔记。')
      .addToggle(t => t.setValue(s.vertical).onChange(on => saveAndRefresh({ vertical: on })));
    if (!s.vertical && s.edges === 'orthogonal') {
      new Setting(containerEl).setName('自动选择横竖').setDesc('横排、竖排各排一次，选缩放到笔记栏宽度后更矮且字不会太小的那个；两者差不多时按源码方向。图越大越耗时。')
        .addToggle(t => t.setValue(s.autoDirection).onChange(on => save({ autoDirection: on })));
    }
    new Setting(containerEl).setName('直角走线').setDesc('开启后连线只走水平和垂直线（ELK 排版）；关闭则用 Mermaid 默认的平滑曲线（dagre 排版）。')
      .addToggle(t => t.setValue(s.edges === 'orthogonal').onChange(on => saveAndRefresh({ edges: on ? 'orthogonal' : 'curved' })));
    if (s.edges === 'orthogonal') {
      new Setting(containerEl).setName('连线交叉处').setDesc('两条直角连线交叉时的画法。')
        .addDropdown(d => d.addOptions({ arc: '跳线（半圆绕过）', gap: '断开', none: '直接交叉' })
          .setValue(s.hops).onChange(v => save({ hops: v as RenderSettings['hops'] })));
    }
    new Setting(containerEl).setName('紧凑程度').setDesc('节点间距、层间距和节点内边距，直角走线和平滑曲线都生效。宽松即 Mermaid 默认值。')
      .addDropdown(d => d.addOptions({ compact: '紧凑', normal: '适中', loose: '宽松' })
        .setValue(s.density).onChange(v => save({ density: v as Density })));

    new Setting(containerEl).setName('外观').setHeading();
    new Setting(containerEl).setName('配色主题').setDesc('“跟随明暗”在浅色模式用 Mermaid 默认主题，深色模式用暗色主题。')
      .addDropdown(d => d.addOptions({ auto: '跟随明暗', default: '默认', neutral: '中性', forest: '森林', dark: '暗色', base: '基础' })
        .setValue(s.theme).onChange(v => save({ theme: v as ThemeChoice })));
    new Setting(containerEl).setName('字体').setDesc('CSS 字体名，可写多个用逗号分隔；留空使用 Mermaid 默认字体。例如：var(--font-interface)')
      .addText(t => t.setPlaceholder('"trebuchet ms", verdana, arial, sans-serif').setValue(s.fontFamily)
        .onChange(v => save({ fontFamily: v })));
    new Setting(containerEl).setName('字号').setDesc('单位 px。')
      .addSlider(sl => sl.setLimits(10, 22, 1).setValue(s.fontSize).setDynamicTooltip().onChange(v => save({ fontSize: v })));
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
