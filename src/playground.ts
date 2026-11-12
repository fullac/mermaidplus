// 用途：提供原生与增强渲染对照、注释草稿编辑及诊断提示，不写回任何笔记。
import { readAnnotations, setNodeStyles, type StyleType } from './annotations';
import { parseFlowchart } from './flowchart';
import { renderEnhanced } from './render';
import { defaultLayoutSettings, type LayoutSettings } from './layout';

export type NativeRenderer = (source: string, target: HTMLElement) => Promise<void | (() => void)>;

export function createPlayground(root: HTMLElement, initialSource: string, native: NativeRenderer) {
  const doc = root.ownerDocument;
  root.classList.add('mp-playground');
  root.classList.remove('mp-focus-enhanced');
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string) {
    const el = doc.createElement(tag); if (text) el.textContent = text; parent.append(el); return el;
  }
  element('h2', root, 'Mermaid Plus · 样式与自动布局');
  element('p', root, '保留图的内容，自动整理节点与连线。样式来自注释，布局选项仅影响右侧预览。').className = 'mp-intro';
  const layoutControls = element('div', root); layoutControls.className = 'mp-controls mp-layout-controls';
  function select(name: string, choices: [string, string][], initial: string) {
    const label = element('label', layoutControls, name), select = element('select', label);
    select.setAttribute('aria-label', name);
    for (const [value, text] of choices) { const option = element('option', select, text); option.value = value; }
    select.value = initial; return select;
  }
  const direction = select('排版方向', [['auto','自动选择'],['source','跟随源码'],['TB','自上而下'],['LR','从左到右']], defaultLayoutSettings.direction);
  const spacing = select('节点间距', [['compact','紧凑'],['normal','适中'],['roomy','宽松']], defaultLayoutSettings.spacing);
  const lines = select('连线样式', [['rounded','圆角折线'],['orthogonal','直角折线']], defaultLayoutSettings.lines);
  const optimize = element('button', layoutControls, '自动整理'); optimize.type = 'button';
  const expand = element('button', layoutControls, '展开增强图'); expand.type = 'button';
  expand.setAttribute('aria-pressed', 'false');
  const columns = element('div', root); columns.className = 'mp-columns';
  const standardPanel = element('section', columns), enhancedPanel = element('section', columns);
  element('h3', standardPanel, '普通 Mermaid');
  const standard = element('div', standardPanel); standard.className = 'mp-preview mp-standard';
  element('h3', enhancedPanel, '增强排版');
  const enhanced = element('div', enhancedPanel); enhanced.className = 'mp-preview mp-enhanced';
  const status = element('p', root); status.className = 'mp-status'; status.setAttribute('role', 'status');
  const form = element('form', root); form.className = 'mp-controls';
  const nodeLabel = element('label', form, '节点'); const nodeSelect = element('select', nodeLabel);
  nodeSelect.setAttribute('aria-label', '节点');
  const fragmentLabel = element('label', form, '文字片段'); const fragment = element('input', fragmentLabel); fragment.placeholder = '例如 getUser()';
  const styleLabel = element('label', form, '样式'); const styleSelect = element('select', styleLabel);
  styleSelect.setAttribute('aria-label', '样式');
  for (const [value, name] of [['code','内联代码'],['highlight','高亮'],['bold','加粗'],['italic','斜体']]) {
    const option = element('option', styleSelect, name); option.value = value!;
  }
  const apply = element('button', form, '添加样式'); apply.type = 'submit';
  const clear = element('button', form, '清除该节点样式'); clear.type = 'button';
  const sourceLabel = element('label', root, 'Mermaid 源码草稿'); sourceLabel.className = 'mp-source-label';
  const source = element('textarea', sourceLabel); source.value = initialSource; source.spellcheck = false;
  const actions = element('div', root); actions.className = 'mp-actions';
  const refresh = element('button', actions, '刷新预览'); refresh.type = 'button';
  const copy = element('button', actions, '复制源码'); copy.type = 'button';
  const reset = element('button', actions, '恢复初始示例'); reset.type = 'button';
  let revision = 0, disposed = false;
  let nativeCleanup: (() => void) | void;
  let layoutController: AbortController | undefined;
  async function render() {
    const current = ++revision, value = source.value;
    layoutController?.abort();
    const controller = new AbortController(); layoutController = controller;
    const settings: LayoutSettings = { direction: direction.value as LayoutSettings['direction'], spacing: spacing.value as LayoutSettings['spacing'], lines: lines.value as LayoutSettings['lines'] };
    status.textContent = '正在渲染…';
    apply.disabled = true; clear.disabled = true;
    await doc.fonts.ready;
    if (disposed || current !== revision) return;
    const messages: string[] = [];
    const enhancedStage = element('div', root); enhancedStage.className = 'mp-enhanced-staging';
    enhancedStage.style.width = `${enhanced.clientWidth || 600}px`;
    try {
      messages.push(...await renderEnhanced(enhancedStage, value, settings, controller.signal));
      if (disposed || current !== revision) return;
      enhanced.replaceChildren(...enhancedStage.childNodes);
      const old = nodeSelect.value; nodeSelect.replaceChildren();
      for (const node of parseFlowchart(value).nodes) {
        const option = element('option', nodeSelect, `${node.id} · ${node.label.replace(/\n/g, " ")}`); option.value = node.id;
      }
      if ([...nodeSelect.options].some(o => o.value === old)) nodeSelect.value = old;
      apply.disabled = !nodeSelect.value; clear.disabled = !nodeSelect.value;
    } catch (error) {
      if (disposed || current !== revision) return;
      enhanced.textContent = '此语法暂不支持增强渲染，源码未改动。'; messages.push(String(error));
    } finally { enhancedStage.remove(); }
    // 渲染到可测量的临时容器；避免较慢的旧任务覆盖新预览。
    const staging = element('div', root); staging.className = 'mp-native-staging';
    try {
      const cleanup = await native(value, staging);
      if (!disposed && current === revision) {
        nativeCleanup?.(); nativeCleanup = cleanup;
        standard.replaceChildren(...staging.childNodes);
      } else cleanup?.();
    } catch (error) {
      if (!disposed && current === revision) {
        nativeCleanup?.(); nativeCleanup = undefined;
        standard.textContent = '原生渲染失败，请检查源码。';
      }
      messages.push(String(error));
    } finally { staging.remove(); }
    if (!disposed && current === revision) status.textContent = messages.length ? messages.join(' ') : '渲染完成 · 已自动整理节点与连线 · 未写入笔记';
  }
  function updateStyles(clearAll: boolean) {
    try {
      const node = parseFlowchart(source.value).nodes.find(n => n.id === nodeSelect.value);
      if (!node) return;
      const a = readAnnotations(source.value).annotations.find(a => a.node === node.id);
      if (a && a.label !== node.raw && !clearAll) throw new Error('原始文字已变化，请先明确清除该节点旧样式，再添加新样式。');
      const styles = a?.label === node.raw ? [...a.styles] : [];
      if (!clearAll) styles.push({ text: fragment.value, type: styleSelect.value as StyleType });
      source.value = setNodeStyles(source.value, node.id, node.raw, clearAll ? [] : styles);
      void render();
    } catch (error) { status.textContent = String(error); }
  }
  form.addEventListener('submit', e => { e.preventDefault(); updateStyles(false); });
  clear.addEventListener('click', () => updateStyles(true));
  optimize.addEventListener('click', () => { void render(); });
  expand.addEventListener('click', () => {
    const expanded = root.classList.toggle('mp-focus-enhanced');
    expand.textContent = expanded ? '恢复对照' : '展开增强图';
    expand.setAttribute('aria-pressed', String(expanded));
    void render();
  });
  for (const control of [direction, spacing, lines]) control.addEventListener('change', () => { void render(); });
  refresh.addEventListener('click', () => { void render(); });
  reset.addEventListener('click', () => { source.value = initialSource; void render(); });
  copy.addEventListener('click', () => {
    void doc.defaultView?.navigator.clipboard.writeText(source.value)
      .then(() => { status.textContent = '源码已复制。'; })
      .catch(() => { source.select(); status.textContent = '请按 Cmd/Ctrl+C 复制所选源码。'; });
  });
  const ready = render();
  return { ready, dispose() { disposed = true; revision++; layoutController?.abort(); nativeCleanup?.(); root.replaceChildren(); } };
}
