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
    new Setting(containerEl).setName('纵向排列')
      .addToggle(t => t.setValue(s.vertical).onChange(on => saveAndRefresh({ vertical: on })));
    if (!s.vertical && s.edges === 'orthogonal') {
      new Setting(containerEl).setName('自动选择排列方向')
        .addToggle(t => t.setValue(s.autoDirection).onChange(on => save({ autoDirection: on })));
    }
    new Setting(containerEl).setName('直角走线')
      .addToggle(t => t.setValue(s.edges === 'orthogonal').onChange(on => saveAndRefresh({ edges: on ? 'orthogonal' : 'curved' })));
    if (s.edges === 'orthogonal') {
      new Setting(containerEl).setName('连线交叉方式')
        .addDropdown(d => d.addOptions({ arc: '跳线', gap: '断开', none: '交叉' })
          .setValue(s.hops).onChange(v => save({ hops: v as RenderSettings['hops'] })));
    }
    new Setting(containerEl).setName('紧凑程度')
      .addDropdown(d => d.addOptions({ compact: '紧凑', normal: '适中', loose: '宽松' })
        .setValue(s.density).onChange(v => save({ density: v as Density })));

    new Setting(containerEl).setName('外观').setHeading();
    new Setting(containerEl).setName('主题')
      .addDropdown(d => d.addOptions({ auto: '跟随明暗', default: '默认', neutral: '中性', forest: '森林', dark: '暗色', base: '基础' })
        .setValue(s.theme).onChange(v => save({ theme: v as ThemeChoice })));
    new Setting(containerEl).setName('字体').setDesc('填字体名，多个用英文逗号隔开，前面的优先，比如 PingFang SC, Arial。不填就用默认字体。')
      .addText(t => t.setPlaceholder('"trebuchet ms", verdana, arial, sans-serif').setValue(s.fontFamily)
        .onChange(v => save({ fontFamily: v })));
    new Setting(containerEl).setName('字号')
      .addSlider(sl => sl.setLimits(10, 22, 1).setValue(s.fontSize).setDynamicTooltip().onChange(v => save({ fontSize: v })));
    // 取色器拖动时会连续触发修改，这里只切换“恢复透明”按钮，不重画设置页，免得打断取色。
    let reset: HTMLElement | undefined;
    const background = new Setting(containerEl).setName('背景');
    background.addColorPicker(c => c.setValue(s.background || '#ffffff').onChange(v => {
      void save({ background: v }); reset?.toggle(true);
    }));
    background.addExtraButton(b => {
      b.setIcon('reset').setTooltip('恢复透明').onClick(() => saveAndRefresh({ background: '' }));
      reset = b.extraSettingsEl; reset.toggle(!!s.background);
    });
  }
}

export default class MermaidPlus extends Plugin {
  settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };
  private blocks?: DiagramBlocks;
  private editing?: InlineEditing;
  private repaintTimer = 0;

  async onload() {
    const saved = (await this.loadData()) ?? {};
    // 旧版本的“排版 / 连线拐弯”两项已合并为“连线”。
    delete saved.layout; delete saved.curve;
    this.settings = { ...DEFAULT_RENDER_SETTINGS, ...saved };
    const editing = this.editing = new InlineEditing(this, () => this.settings);
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
    this.repaintTimer = window.setTimeout(() => { this.editing?.refresh(); void this.blocks?.repaint(); }, 250);
  }
}
