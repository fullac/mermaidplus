// 用途：在流程图原位置提供可视化编辑。图由宿主用 Mermaid 原生渲染（与阅读视图完全一致），
// 本模块在其上叠加类似 Obsidian 白板（Canvas）的交互：点选、悬浮工具条、四边连接点拖拽连线、双击改字或新建节点。
import { addEdge, addNode, deleteEdge, deleteNode, setEdgeLabel, setNodeLabel, type EditResult } from './edit';
import { editText, parseFlowchart, type Flowchart } from './flowchart';
import { toggleMark, type Mark } from './markdownLabel';
import { clearLayout, createMover, readLayout, setNodeOffset, type Mover } from './manualLayout';

export interface EditorState { node?: string; edge?: number; editing?: boolean }

export interface EditHost {
  /** 用 Mermaid 原生渲染把源码画进 target（其中应出现 svg）；可返回清理函数。 */
  draw(source: string, target: HTMLElement): Promise<void | (() => void)>;
  /** 把 before 换成 after 写回；源码已被别处改动时返回 false，不写入。 */
  commit(before: string, after: string): Promise<boolean>;
  /** 撤销 / 重做；返回撤销后的源码，没有可撤销的内容时返回 null。 */
  undo(): Promise<string | null>;
  redo(): Promise<string | null>;
  /** 选中状态变化时通知宿主，宿主重建界面后可据此恢复。 */
  remember?(state: EditorState): void;
  exit(): void;
}

export interface BlockEditor {
  update(source: string, state?: EditorState): void;
  /** 编辑器当前对应的源码（已写回的最新版本）。 */
  source(): string;
  /** 宿主容器被重建时，把编辑器原样搬进新容器：不重画、保留选中和键盘焦点。 */
  adopt(container: HTMLElement): void;
  dispose(): void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SVG = 'http://www.w3.org/2000/svg';
const hint = '单击选中；拖动节点调整位置，拖动圆点连线；双击改文字，双击空白新建节点；Esc 退出。';

/** 给 Mermaid 生成的 SVG 标上节点编号和连线序号，供点选使用；返回能否完整对应。 */
export function tagMermaidSvg(svg: SVGSVGElement, chart: Flowchart): boolean {
  const ids = new Set(chart.nodes.map(n => n.id));
  const tagged = new Set<string>();
  for (const g of svg.querySelectorAll<SVGGElement>('g.node')) {
    // Mermaid 的节点 id 形如 “<图编号>-flowchart-<节点>-<序号>”，旧版本没有图编号前缀。
    const dataId = g.getAttribute('data-id');
    const id = dataId && ids.has(dataId) ? dataId : g.id.match(/flowchart-(.+)-\d+$/)?.[1];
    if (id && ids.has(id)) { g.setAttribute('data-node-id', id); tagged.add(id); }
  }
  // Mermaid 按源码顺序输出连线。
  const paths = [...new Set(svg.querySelectorAll<SVGPathElement>('path.flowchart-link, .edgePaths > path'))];
  if (paths.length === chart.edges.length) {
    paths.forEach((path, index) => {
      path.setAttribute('data-edge-index', String(index));
      // 透明粗线只用来扩大点选范围。
      const hit = path.cloneNode() as SVGPathElement;
      for (const name of ['id', 'marker-end', 'marker-start', 'style', 'data-id', 'data-edge']) hit.removeAttribute(name);
      hit.setAttribute('class', 'mp-edge-hit');
      path.after(hit);
    });
    // 连线文字：新版本用 data-id 与连线对应，旧版本按有文字的连线顺序对应。
    const byId = new Map(paths.map((path, index) => [path.getAttribute('data-id') ?? '', index]));
    const labelled = chart.edges.flatMap((edge, index) => edge.label ? [index] : []);
    const groups = [...svg.querySelectorAll<SVGGElement>('.edgeLabels > .edgeLabel')].filter(g => g.textContent?.trim());
    groups.forEach((g, i) => {
      const dataId = g.querySelector('[data-id]')?.getAttribute('data-id');
      const index = dataId && byId.has(dataId) ? byId.get(dataId) : labelled[i];
      if (index !== undefined) g.setAttribute('data-edge-index', String(index));
    });
  }
  return tagged.size === chart.nodes.length && paths.length === chart.edges.length;
}

export function mountBlockEditor(container: HTMLElement, initialSource: string, host: EditHost, initialState: EditorState = {}): BlockEditor {
  const doc = container.ownerDocument;
  let source = initialSource, state: EditorState = { ...initialState };
  let busy = false, disposed = false, revision = 0;
  let cleanup: void | (() => void);
  let textBox: HTMLTextAreaElement | undefined;
  let drag: { from: string; line: SVGLineElement; x: number; y: number } | undefined;
  /** 拖动节点：起点（屏幕坐标）、原有偏移、屏幕像素到图坐标的比例；超过 4px 才算开始拖。 */
  let nodeDrag: { id: string; x: number; y: number; start: [number, number]; scale: number; mover?: Mover; moved: boolean; offset: [number, number] } | undefined;
  /** 拖拽松手后浏览器还会补发一次 click，忽略它，免得清掉刚选中的新节点。 */
  let swallowClick = false;

  const root = doc.createElement('div');
  root.className = 'mp-block-editor';
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Mermaid 可视化编辑');
  root.contentEditable = 'false';
  /** 编辑器是否持有键盘焦点；容器被删掉时浏览器会丢掉焦点，搬家后据此还原。 */
  let focused = false;
  root.addEventListener('focusin', () => { focused = true; });
  root.addEventListener('focusout', event => { if (root.isConnected && !root.contains(event.relatedTarget as Node | null)) focused = false; });
  const button = (parent: HTMLElement, text: string, title: string, action: () => void) => {
    const el = doc.createElement('button'); el.type = 'button'; el.textContent = text; el.title = title;
    el.setAttribute('aria-label', text);
    el.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
    parent.append(el); return el;
  };
  const toolbar = doc.createElement('div'); toolbar.className = 'mp-editor-toolbar';
  const status = doc.createElement('div'); status.className = 'mp-editor-status'; status.setAttribute('role', 'status');
  toolbar.append(status);
  const addButton = button(toolbar, '新增节点', '新增节点；选中节点时从它连出（也可双击空白处）', () => void apply(s => addNode(s, '新节点', state.node), true));
  const undoButton = button(toolbar, '撤销', `撤销（${isMac ? '⌘Z' : 'Ctrl+Z'}）`, () => void history('undo'));
  const redoButton = button(toolbar, '重做', `重做（${isMac ? '⇧⌘Z' : 'Ctrl+Y'}）`, () => void history('redo'));
  const resetAllButton = button(toolbar, '重置布局', '所有节点回到自动排版的位置', () => void apply(s => ({ source: clearLayout(s), select: { node: state.node, edge: state.edge } })));
  const doneButton = button(toolbar, '完成', '退出编辑（Esc）', () => host.exit());
  doneButton.classList.add('mp-editor-done');

  const stage = doc.createElement('div'); stage.className = 'mp-editor-stage';
  const canvas = doc.createElement('div'); canvas.className = 'mp-editor-canvas';
  // 叠加层：选中框、连接点、悬浮工具条和拖拽中的连线都画在图上方，不改动 Mermaid 的 SVG 外观。
  const overlay = doc.createElement('div'); overlay.className = 'mp-editor-overlay';
  const frame = doc.createElement('div'); frame.className = 'mp-selection-frame';
  const handles = (['top', 'right', 'bottom', 'left'] as const).map(side => {
    const el = doc.createElement('div'); el.className = `mp-handle mp-handle-${side}`; el.dataset.side = side;
    el.title = '拖到另一个节点上连线，拖到空白处新建节点'; frame.append(el); return el;
  });
  const menu = doc.createElement('div'); menu.className = 'mp-selection-menu'; menu.setAttribute('role', 'toolbar'); menu.setAttribute('aria-label', '选中项操作');
  const editButton = button(menu, '改文字', '修改文字（Enter 或双击）', () => startText());
  const nextButton = button(menu, '接一个节点', '新增一个节点并从这里连过去', () => { if (state.node) { const from = state.node; void apply(s => addNode(s, '新节点', from), true); } });
  const resetButton = button(menu, '复位', '回到自动排版的位置', () => { if (state.node) { const id = state.node; void apply(s => ({ source: clearLayout(s, id), select: { node: id } })); } });
  const deleteButton = button(menu, '删除', '删除（Delete）', () => removeSelection());
  // 改字时选中一段文字，上方出现格式栏；写成 Mermaid 原生 Markdown 标签（**粗体**、*斜体*）。
  const formatBar = doc.createElement('div'); formatBar.className = 'mp-format-bar'; formatBar.setAttribute('role', 'toolbar'); formatBar.setAttribute('aria-label', '文字格式');
  const boldButton = button(formatBar, '加粗', `加粗（${isMac ? '⌘B' : 'Ctrl+B'}）`, () => format('bold'));
  const italicButton = button(formatBar, '斜体', `斜体（${isMac ? '⌘I' : 'Ctrl+I'}）`, () => format('italic'));
  boldButton.classList.add('mp-format-bold'); italicButton.classList.add('mp-format-italic');
  formatBar.hidden = true;
  const wire = doc.createElementNS(SVG, 'svg'); wire.setAttribute('class', 'mp-wire');
  overlay.append(frame, menu, formatBar, wire);
  canvas.append(overlay);
  stage.append(canvas);
  root.append(toolbar, stage);
  container.append(root);

  function say(text: string) { status.textContent = text; }
  function syncButtons() {
    addButton.disabled = busy; undoButton.disabled = busy; redoButton.disabled = busy;
    editButton.disabled = busy; deleteButton.disabled = busy; nextButton.disabled = busy;
    nextButton.hidden = state.node === undefined;
    const offsets = readLayout(source).nodes;
    resetButton.disabled = busy; resetButton.hidden = state.node === undefined || !(state.node in offsets);
    resetAllButton.disabled = busy; resetAllButton.hidden = !Object.keys(offsets).length;
  }
  const diagram = () => [...canvas.children].find(el => el !== overlay)?.querySelector<SVGSVGElement>('svg') ?? null;
  const nodeEl = (id: string) => diagram()?.querySelector<SVGGraphicsElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? null;
  const edgeEls = (index: number) => [...(diagram()?.querySelectorAll<SVGGraphicsElement>(`[data-edge-index="${index}"]`) ?? [])];
  /** 元素在画布坐标系中的位置（画布随舞台一起滚动）。 */
  function box(el: Element) {
    const r = el.getBoundingClientRect(), base = canvas.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
  }

  function place() {
    const targets = state.node !== undefined ? [nodeEl(state.node)].filter((el): el is SVGGraphicsElement => !!el)
      : state.edge !== undefined ? edgeEls(state.edge).filter(el => !el.classList.contains('mp-edge-hit')) : [];
    if (!targets.length) { frame.hidden = true; menu.hidden = true; return; }
    const boxes = targets.map(box);
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const right = Math.max(...boxes.map(b => b.x + b.width)), bottom = Math.max(...boxes.map(b => b.y + b.height));
    const pad = state.node !== undefined ? 6 : 4;
    Object.assign(frame.style, { left: `${x - pad}px`, top: `${y - pad}px`, width: `${right - x + pad * 2}px`, height: `${bottom - y + pad * 2}px` });
    frame.hidden = false;
    frame.classList.toggle('mp-edge-frame', state.edge !== undefined);
    for (const handle of handles) handle.hidden = state.node === undefined;
    menu.hidden = false;
    const menuWidth = menu.offsetWidth || 160, menuHeight = menu.offsetHeight || 30;
    menu.style.left = `${Math.max(0, Math.min(x + (right - x) / 2 - menuWidth / 2, canvas.scrollWidth - menuWidth))}px`;
    // 上方放不下时放到下方。
    const above = y - pad - menuHeight - 10;
    menu.style.top = `${above >= 0 ? above : bottom + pad + 10}px`;
  }

  function select(next: EditorState) {
    state = { node: next.node, edge: next.edge };
    for (const el of canvas.querySelectorAll('.mp-selected')) el.classList.remove('mp-selected');
    if (state.edge !== undefined) for (const el of edgeEls(state.edge)) el.classList.add('mp-selected');
    if (state.node !== undefined) nodeEl(state.node)?.classList.add('mp-selected');
    place();
    host.remember?.(state);
    syncButtons();
  }

  async function render(focusText = false) {
    const current = ++revision;
    closeText(false);
    const staging = doc.createElement('div'); staging.className = 'mp-editor-staging';
    staging.style.width = `${stage.clientWidth || container.clientWidth || 600}px`;
    root.append(staging);
    let nextCleanup: void | (() => void) = undefined;
    try {
      const chart = parseFlowchart(source);
      nextCleanup = await host.draw(source, staging);
      if (disposed || current !== revision) return;
      const drawn = staging.querySelector<SVGSVGElement>('svg');
      if (!drawn) throw new Error('Mermaid 没有生成图。');
      const complete = tagMermaidSvg(drawn, chart);
      const view = doc.createElement('div'); view.className = 'mp-editor-diagram';
      view.append(...staging.childNodes);
      cleanup?.(); cleanup = nextCleanup; nextCleanup = undefined;
      for (const child of [...canvas.children]) if (child !== overlay) child.remove();
      canvas.prepend(view);
      const keep: EditorState = {};
      if (state.node && chart.nodes.some(n => n.id === state.node)) keep.node = state.node;
      if (state.edge !== undefined && chart.edges[state.edge]) keep.edge = state.edge;
      select(keep);
      say(complete ? hint : '有些节点或连线点不中，可以直接改源码。');
      if (focusText) startText();
    } catch (error) {
      if (disposed || current !== revision) return;
      say(`无法编辑：${error instanceof Error ? error.message : String(error)}`);
    } finally { nextCleanup?.(); staging.remove(); }
  }

  async function apply(edit: (source: string) => EditResult, editText = false) {
    if (busy) return;
    let result: EditResult;
    try { result = edit(source); } catch (error) { say(error instanceof Error ? error.message : String(error)); return; }
    if (result.source === source) return;
    busy = true; syncButtons();
    try {
      const ok = await host.commit(source, result.source);
      if (disposed) return;
      if (!ok) { say('这个代码块在别处被改过了，这次没有写入。请退出后重新编辑。'); return; }
      source = result.source;
      state = { node: result.select?.node, edge: result.select?.edge, editing: editText };
      host.remember?.(state);
    } finally { busy = false; syncButtons(); }
    await render(editText);
  }

  async function history(kind: 'undo' | 'redo') {
    if (busy) return;
    busy = true; syncButtons();
    try {
      const next = await host[kind]();
      if (disposed) return;
      if (next === null) { say(kind === 'undo' ? '没有可撤销的修改。' : '没有可重做的修改。'); return; }
      source = next;
    } finally { busy = false; syncButtons(); }
    await render();
  }

  function removeSelection() {
    if (state.node !== undefined) { const id = state.node; void apply(s => deleteNode(s, id)); }
    else if (state.edge !== undefined) { const index = state.edge; void apply(s => deleteEdge(s, index)); }
  }

  /** 在选中对象上方覆盖一个文本框；Enter 保存，Shift+Enter 换行，Esc 取消。 */
  function startText() {
    if (busy || (state.node === undefined && state.edge === undefined)) return;
    closeText(false);
    const chart = parseFlowchart(source);
    const target = state.node !== undefined ? nodeEl(state.node)
      : edgeEls(state.edge!).find(el => el.classList.contains('edgeLabel')) ?? edgeEls(state.edge!).find(el => el.tagName.toLowerCase() === 'path' && !el.classList.contains('mp-edge-hit'));
    if (!target) return;
    const value = editText(state.node !== undefined ? chart.nodes.find(n => n.id === state.node)!.raw : chart.edges[state.edge!]!.raw);
    const b = box(target);
    const input = doc.createElement('textarea');
    input.className = 'mp-editor-text';
    input.setAttribute('aria-label', state.node !== undefined ? '节点文字' : '连线文字');
    input.value = value;
    const width = Math.max(140, state.node !== undefined ? b.width : 0), height = Math.max(44, state.node !== undefined ? b.height : 0);
    input.style.left = `${b.x + b.width / 2 - width / 2}px`;
    input.style.top = `${b.y + b.height / 2 - height / 2}px`;
    input.style.width = `${width}px`; input.style.height = `${height}px`;
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && (event.key.toLowerCase() === 'b' || event.key.toLowerCase() === 'i')) {
        event.preventDefault(); format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic'); return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); closeText(true); }
      else if (event.key === 'Escape') { event.preventDefault(); closeText(false); root.focus({ preventScroll: true }); }
    });
    input.addEventListener('blur', () => { if (textBox === input) closeText(true); });
    for (const type of ['select', 'keyup', 'mouseup', 'input'] as const) input.addEventListener(type, () => placeFormatBar());
    menu.hidden = true;
    overlay.append(input); textBox = input;
    input.focus({ preventScroll: true }); input.select();
  }

  /** 有选中文字时把格式栏放在编辑框上方（放不下时放下方）。 */
  function placeFormatBar() {
    const input = textBox;
    if (!input || input.selectionStart === input.selectionEnd) { formatBar.hidden = true; return; }
    formatBar.hidden = false;
    const left = parseFloat(input.style.left) || 0, top = parseFloat(input.style.top) || 0;
    const height = formatBar.offsetHeight || 28;
    formatBar.style.left = `${Math.max(0, left)}px`;
    formatBar.style.top = `${top - height - 12 >= 0 ? top - height - 12 : top + input.offsetHeight + 12}px`;
  }

  function format(mark: Mark) {
    const input = textBox;
    if (!input) return;
    const next = toggleMark(input.value, input.selectionStart, input.selectionEnd, mark);
    if (next.value === input.value) return;
    input.value = next.value;
    input.focus({ preventScroll: true });
    input.setSelectionRange(next.start, next.end);
    placeFormatBar();
  }

  function closeText(save: boolean) {
    const input = textBox;
    if (!input) return;
    textBox = undefined; input.remove(); formatBar.hidden = true;
    if (!save) { place(); return; }
    const text = input.value;
    if (state.node !== undefined) {
      const id = state.node, node = parseFlowchart(source).nodes.find(n => n.id === id);
      if (node && editText(node.raw) === text.trim()) { place(); return; }
      void apply(s => setNodeLabel(s, id, text));
    } else if (state.edge !== undefined) {
      const index = state.edge, edge = parseFlowchart(source).edges[index];
      if (edge && editText(edge.raw) === text.trim()) { place(); return; }
      void apply(s => setEdgeLabel(s, index, text));
    }
  }

  function hitAt(target: EventTarget | null): EditorState | null {
    const el = (target as Element | null)?.closest?.('[data-node-id], [data-edge-index]');
    if (!el || !canvas.contains(el) || overlay.contains(el)) return null;
    const node = el.getAttribute('data-node-id');
    return node !== null ? { node } : { edge: Number(el.getAttribute('data-edge-index')) };
  }
  const pointIn = (event: MouseEvent) => { const base = canvas.getBoundingClientRect(); return { x: event.clientX - base.left, y: event.clientY - base.top }; };

  // 编辑区内的鼠标与键盘事件不再传给外层编辑器，避免点击时光标跳进源码。
  for (const type of ['mousedown', 'pointerdown', 'pointerup', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'input', 'beforeinput'] as const) {
    root.addEventListener(type, event => event.stopPropagation());
  }
  root.addEventListener('mousedown', event => {
    if (!(event.target as Element).closest('textarea')) { event.preventDefault(); if (!textBox) root.focus({ preventScroll: true }); }
  });

  // 与白板相同：从连接点拖出连线，放到节点上连线，放到空白处新建节点。
  for (const handle of handles) handle.addEventListener('pointerdown', event => {
    if (busy || state.node === undefined) return;
    event.preventDefault(); event.stopPropagation();
    const b = box(handle), x = b.x + b.width / 2, y = b.y + b.height / 2;
    const line = doc.createElementNS(SVG, 'line');
    for (const [k, v] of [['x1', x], ['y1', y], ['x2', x], ['y2', y]] as const) line.setAttribute(k, String(v));
    wire.append(line);
    drag = { from: state.node, line, x, y };
    root.classList.add('mp-connecting');
    say('拖到另一个节点上松开就能连线，拖到空白处会新建节点。');
  });
  // 拖动节点调整位置：拖动中只移动画面，松手后把偏移写进源码的位置注释。
  stage.addEventListener('pointerdown', event => {
    if (busy || textBox || event.button !== 0) return;
    const target = event.target as Element;
    if (menu.contains(target) || target.closest('.mp-handle')) return;
    // 选中框不接收鼠标，所以点到的就是节点本身。
    const hit = hitAt(target);
    const svg = diagram();
    if (!hit?.node || !svg) return;
    const rect = svg.getBoundingClientRect(), view = svg.viewBox.baseVal;
    const scale = view && view.width && rect.width ? view.width / rect.width : 1;
    const offset = readLayout(source).nodes[hit.node] ?? [0, 0];
    nodeDrag = { id: hit.node, x: event.clientX, y: event.clientY, start: [offset[0], offset[1]], scale, moved: false, offset: [offset[0], offset[1]] };
  });
  function dragNode(event: PointerEvent) {
    const d = nodeDrag!;
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      const svg = diagram();
      if (!svg) { nodeDrag = undefined; return; }
      d.moved = true;
      d.mover = createMover(svg, parseFlowchart(source));
      root.classList.add('mp-moving');
      if (state.node !== d.id) select({ node: d.id });
      menu.hidden = true;
    }
    d.offset = [d.start[0] + dx * d.scale, d.start[1] + dy * d.scale];
    d.mover!.move({ ...readLayout(source).nodes, [d.id]: d.offset }, false);
    place(); menu.hidden = true;
  }
  function dropNode() {
    const d = nodeDrag!; nodeDrag = undefined;
    if (!d.moved) return;
    root.classList.remove('mp-moving');
    swallowClick = true; setTimeout(() => { swallowClick = false; }, 0);
    const [x, y] = d.offset, id = d.id, before = source;
    void apply(s => ({ source: setNodeOffset(s, id, x, y), select: { node: id } })).then(() => {
      // 没写入（位置没变或冲突）时把画面恢复到源码里的位置；写入了则已按新源码重画。
      const svg = diagram();
      if (disposed || source !== before || !svg) return;
      try { createMover(svg, parseFlowchart(source)).move(readLayout(source).nodes, true); } catch { /* 解析不了就保持原样 */ }
      place();
    });
  }

  const clearDrop = () => { for (const el of canvas.querySelectorAll('.mp-drop-target')) el.classList.remove('mp-drop-target'); };
  const move = (event: PointerEvent) => {
    if (nodeDrag) { dragNode(event); return; }
    if (!drag) return;
    const p = pointIn(event);
    drag.line.setAttribute('x2', String(p.x)); drag.line.setAttribute('y2', String(p.y));
    clearDrop();
    const over = hitAt(doc.elementFromPoint(event.clientX, event.clientY));
    if (over?.node) nodeEl(over.node)?.classList.add('mp-drop-target');
  };
  const drop = (event: PointerEvent) => {
    if (nodeDrag) { dropNode(); return; }
    if (!drag) return;
    const { from, line, x, y } = drag; drag = undefined;
    line.remove(); root.classList.remove('mp-connecting'); clearDrop();
    swallowClick = true; setTimeout(() => { swallowClick = false; }, 0);
    const p = pointIn(event);
    if (Math.hypot(p.x - x, p.y - y) < 8) { say(hint); return; }
    const inside = stage.contains(doc.elementFromPoint(event.clientX, event.clientY));
    const over = hitAt(doc.elementFromPoint(event.clientX, event.clientY));
    if (over?.node) void apply(s => addEdge(s, from, over.node!));
    else if (!over && inside) void apply(s => addNode(s, '新节点', from), true);
    else say(hint);
  };
  // 编辑区会拦下冒泡的鼠标事件，所以在捕获阶段监听。
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointerup', drop, true);

  stage.addEventListener('click', event => {
    if (swallowClick) { swallowClick = false; return; }
    const target = event.target as Element;
    if (menu.contains(target) || target.closest('textarea')) return;
    // 点到选中框内部（不是连接点）等同于点框下面的节点本身。
    if (frame.contains(target)) return;
    select(hitAt(target) ?? {});
  });
  stage.addEventListener('dblclick', event => {
    const target = event.target as Element;
    if (menu.contains(target) || textBox) return;
    if (frame.contains(target)) { if (!target.closest('.mp-handle')) startText(); return; }
    const hit = hitAt(target);
    if (hit) { select(hit); startText(); }
    else void apply(s => addNode(s, '新节点'), true);
  });

  root.addEventListener('keydown', event => {
    if (event.target !== root) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); void history(event.shiftKey ? 'redo' : 'undo'); }
    else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); void history('redo'); }
    else if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); startText(); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelection(); }
    else if (event.key.startsWith('Arrow') && state.node !== undefined) {
      // 方向键微调选中节点：每次 10，按住 Shift 每次 1。
      event.preventDefault();
      const step = event.shiftKey ? 1 : 10, id = state.node;
      const [dx, dy] = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key] ?? [0, 0];
      void apply(s => { const [x, y] = readLayout(s).nodes[id] ?? [0, 0]; return { source: setNodeOffset(s, id, x + dx, y + dy), select: { node: id } }; });
    }
    else if (event.key === 'Escape') {
      event.preventDefault();
      if (state.node !== undefined || state.edge !== undefined) select({});
      else host.exit();
    }
  });
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (!textBox) place(); }) : undefined;
  resize?.observe(stage);

  frame.hidden = true; menu.hidden = true;
  syncButtons();
  say('正在渲染…');
  void render(initialState.editing).then(() => { if (!initialState.editing && !disposed) root.focus({ preventScroll: true }); });
  return {
    update(next, nextState) { source = next; if (nextState) state = { ...nextState }; void render(nextState?.editing); },
    source: () => source,
    adopt(next) {
      if (root.parentElement === next) return;
      const refocus = focused && !textBox;
      next.append(root);
      if (refocus) root.focus({ preventScroll: true });
      place();
    },
    dispose() {
      disposed = true; revision++; textBox = undefined;
      doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerup', drop, true);
      resize?.disconnect(); cleanup?.(); root.remove();
    },
  };
}
