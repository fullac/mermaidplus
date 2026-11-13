// 用途：在时序图原位置提供可视化编辑。图由宿主用 Mermaid 原生渲染，本模块叠加点选、改字、增删和调序。
// 接口与 mountBlockEditor 相同。参与者记在 EditorState.node，消息记在 EditorState.edge；注释选择只留在本编辑器内。
import type { BlockEditor, EditHost, EditorState } from './blockEditor';
import { copyCanvasTone } from './canvasTone';
import type { EditResult } from './edit';
import { editText } from './flowchart';
import { parseSequence, structuralBlock, type SequenceDiagram } from './sequence';
import {
  addMessage, addParticipant, deleteMessage, deleteParticipant, moveMessage, moveParticipant,
  noteUses, setMessageText, setNoteText, setParticipantLabel,
} from './sequenceEdit';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const hint = '单击选中；双击改文字；方向键调整参与者左右或消息上下；Esc 退出。';

interface LocalState extends EditorState { note?: number }

/** 给时序图 SVG 标上参与者 id、消息序号和注释序号。消息数量对不上时不标消息，避免改错行。 */
function tagSequenceSvg(svg: SVGSVGElement, chart: SequenceDiagram): { participants: boolean; messages: boolean } {
  const ids = new Set(chart.participants.map(item => item.id));
  for (const el of svg.querySelectorAll<SVGGraphicsElement>('[data-et="participant"]')) {
    const id = el.getAttribute('data-id');
    if (id && ids.has(id)) el.setAttribute('data-node-id', id);
  }
  // 底部镜像没有 data-et，但带 name 和 actor-bottom。
  for (const el of svg.querySelectorAll<SVGGraphicsElement>('[name].actor-bottom')) {
    const id = el.getAttribute('name');
    if (id && ids.has(id)) el.setAttribute('data-node-id', id);
  }
  for (const el of svg.querySelectorAll<SVGGraphicsElement>('[data-et="life-line"]')) {
    const id = el.getAttribute('data-id');
    if (id && ids.has(id)) el.setAttribute('data-node-id', id);
  }

  const lines = [...svg.querySelectorAll<SVGGraphicsElement>('[data-et="message"]')];
  const texts = [...svg.querySelectorAll<SVGGraphicsElement>('text.messageText, .messageText')];
  const messages = lines.length === chart.messages.length;
  if (messages) {
    lines.forEach((line, index) => {
      line.setAttribute('data-edge-index', String(index));
      const hit = line.cloneNode() as SVGGraphicsElement;
      for (const name of ['id', 'marker-end', 'marker-start', 'style', 'data-id', 'data-et', 'data-from', 'data-to']) hit.removeAttribute(name);
      hit.setAttribute('class', 'mp-edge-hit');
      line.after(hit);
    });
    if (texts.length === chart.messages.length) texts.forEach((text, index) => text.setAttribute('data-edge-index', String(index)));
  }
  const notes = [...svg.querySelectorAll<SVGGraphicsElement>('[data-et="note"]')];
  if (notes.length === chart.notes.length) notes.forEach((note, index) => note.setAttribute('data-note-index', String(index)));
  const tagged = new Set([...svg.querySelectorAll('[data-node-id]')].map(el => el.getAttribute('data-node-id')));
  return { participants: [...ids].every(id => tagged.has(id)), messages };
}

export function mountSequenceEditor(container: HTMLElement, initialSource: string, host: EditHost, initialState: EditorState = {}): BlockEditor {
  const doc = container.ownerDocument;
  let source = initialSource;
  let state: LocalState = { node: initialState.node, edge: initialState.edge };
  let busy = false, disposed = false, revision = 0;
  let cleanup: void | (() => void);
  let displayedSource = '', rendering = false;
  let pendingRender: { source: string; revision: number; focusText: boolean } | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const renderWaiters: (() => void)[] = [];
  let textBox: HTMLTextAreaElement | undefined;
  let messagesTagged = true;

  const root = doc.createElement('div');
  root.className = 'mp-block-editor';
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Mermaid 时序图编辑');
  root.contentEditable = 'false';
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
  button(toolbar, '源码', '退出编辑并查看源码', () => host.exit());
  const addActor = button(toolbar, '新增参与者', '在声明末尾新增一名参与者', () => void apply(s => addParticipant(s), true));
  const addMsg = button(toolbar, '新增消息', '在选中消息后新增一条消息；没选中则追加到末尾', () => void apply(s => addMessage(s, state.edge, state.node), true));
  const upButton = button(toolbar, '上移', '把选中的消息与上一条紧邻消息交换', () => { if (state.edge !== undefined) void apply(s => moveMessage(s, state.edge!, -1)); });
  const downButton = button(toolbar, '下移', '把选中的消息与下一条紧邻消息交换', () => { if (state.edge !== undefined) void apply(s => moveMessage(s, state.edge!, 1)); });
  const leftButton = button(toolbar, '左移', '把选中的参与者声明与左边一位交换', () => { if (state.node) void apply(s => moveParticipant(s, state.node!, -1)); });
  const rightButton = button(toolbar, '右移', '把选中的参与者声明与右边一位交换', () => { if (state.node) void apply(s => moveParticipant(s, state.node!, 1)); });
  const undoButton = button(toolbar, '撤销', `撤销（${isMac ? '⌘Z' : 'Ctrl+Z'}）`, () => void history('undo'));
  const redoButton = button(toolbar, '重做', `重做（${isMac ? '⇧⌘Z' : 'Ctrl+Y'}）`, () => void history('redo'));
  const doneButton = button(toolbar, '完成', '退出编辑（Esc）', () => host.exit());
  doneButton.classList.add('mp-editor-done');

  const stage = doc.createElement('div'); stage.className = 'mp-editor-stage';
  const canvas = doc.createElement('div'); canvas.className = 'mp-editor-canvas';
  const overlay = doc.createElement('div'); overlay.className = 'mp-editor-overlay';
  const frame = doc.createElement('div'); frame.className = 'mp-selection-frame';
  const menu = doc.createElement('div'); menu.className = 'mp-selection-menu'; menu.setAttribute('role', 'toolbar'); menu.setAttribute('aria-label', '选中项操作');
  const editButton = button(menu, '改文字', '修改文字（Enter 或双击）', () => startText());
  const deleteButton = button(menu, '删除', '删除（Delete）', () => removeSelection());
  overlay.append(frame, menu);
  canvas.append(overlay);
  stage.append(canvas);
  root.append(toolbar, stage);
  container.append(root);

  function say(text: string) { status.textContent = text; }
  function chartOf(value = source): SequenceDiagram | undefined {
    try { return parseSequence(value); } catch { return undefined; }
  }
  function locked() { const chart = chartOf(); return chart ? structuralBlock(chart) : null; }
  function syncButtons() {
    const reason = locked();
    const structural = busy || !!reason;
    addActor.disabled = structural;
    addMsg.disabled = structural;
    upButton.disabled = structural || state.edge === undefined;
    downButton.disabled = structural || state.edge === undefined;
    leftButton.disabled = structural || !state.node;
    rightButton.disabled = structural || !state.node;
    undoButton.disabled = busy;
    redoButton.disabled = busy;
    editButton.disabled = busy || (state.node === undefined && state.edge === undefined && state.note === undefined);
    const chart = chartOf();
    const participant = chart?.participants.find(item => item.id === state.node);
    const used = !!(chart && state.node && (chart.messages.some(item => item.from === state.node || item.to === state.node) || noteUses(chart, state.node).length || participant?.line === undefined));
    deleteButton.disabled = busy || !!reason || (state.node === undefined && state.edge === undefined) || (state.node !== undefined && used);
    deleteButton.hidden = state.note !== undefined && state.node === undefined && state.edge === undefined;
  }

  const diagram = () => [...canvas.children].find(el => el !== overlay)?.querySelector<SVGSVGElement>('svg') ?? null;
  const nodeEls = (id: string) => [...(diagram()?.querySelectorAll<SVGGraphicsElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? [])];
  const edgeEls = (index: number) => [...(diagram()?.querySelectorAll<SVGGraphicsElement>(`[data-edge-index="${index}"]`) ?? [])];
  const noteEls = (index: number) => [...(diagram()?.querySelectorAll<SVGGraphicsElement>(`[data-note-index="${index}"]`) ?? [])];

  function box(el: Element) {
    const r = el.getBoundingClientRect(), base = canvas.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height };
  }

  function targets(): SVGGraphicsElement[] {
    if (state.node !== undefined) return nodeEls(state.node).filter(el => el.getAttribute('data-et') !== 'life-line');
    if (state.edge !== undefined) return edgeEls(state.edge).filter(el => !el.classList.contains('mp-edge-hit'));
    if (state.note !== undefined) return noteEls(state.note);
    return [];
  }

  function place() {
    const current = targets();
    if (!current.length) { frame.hidden = true; menu.hidden = true; return; }
    const boxes = current.map(box);
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const right = Math.max(...boxes.map(b => b.x + b.width)), bottom = Math.max(...boxes.map(b => b.y + b.height));
    const pad = state.edge !== undefined ? 4 : 6;
    Object.assign(frame.style, { left: `${x - pad}px`, top: `${y - pad}px`, width: `${right - x + pad * 2}px`, height: `${bottom - y + pad * 2}px` });
    frame.hidden = false;
    frame.classList.toggle('mp-edge-frame', state.edge !== undefined);
    menu.hidden = false;
    const menuWidth = menu.offsetWidth || 120, menuHeight = menu.offsetHeight || 30;
    menu.style.left = `${Math.max(0, Math.min(x + (right - x) / 2 - menuWidth / 2, canvas.scrollWidth - menuWidth))}px`;
    const above = y - pad - menuHeight - 10;
    menu.style.top = `${above >= 0 ? above : bottom + pad + 10}px`;
  }

  function publicState(): EditorState {
    return { node: state.node, edge: state.edge };
  }

  function select(next: LocalState) {
    state = { node: next.node, edge: next.edge, note: next.note };
    for (const el of canvas.querySelectorAll('.mp-selected')) el.classList.remove('mp-selected');
    for (const el of targets()) el.classList.add('mp-selected');
    place();
    host.remember?.(publicState());
    syncButtons();
  }

  function render(focusText = false): Promise<void> {
    pendingRender = { source, revision: ++revision, focusText };
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => void flushRender(), displayedSource ? 80 : 0);
    return new Promise(resolve => renderWaiters.push(resolve));
  }

  async function flushRender() {
    if (disposed || rendering || !pendingRender) return;
    if (textBox) { renderTimer = setTimeout(() => void flushRender(), 80); return; }
    const request = pendingRender; pendingRender = undefined; rendering = true;
    try { await drawOnce(request.source, request.revision, request.focusText); }
    finally {
      rendering = false;
      if (pendingRender && !disposed) renderTimer = setTimeout(() => void flushRender(), 80);
      else renderWaiters.splice(0).forEach(resolve => resolve());
    }
  }

  async function drawOnce(snapshot: string, current: number, focusText: boolean) {
    const previousHeight = canvas.getBoundingClientRect().height;
    canvas.style.minHeight = `${previousHeight}px`;
    const staging = doc.createElement('div'); staging.className = 'mp-editor-staging';
    staging.style.width = `${stage.clientWidth || container.clientWidth || 600}px`;
    root.append(staging);
    let nextCleanup: void | (() => void) = undefined;
    try {
      const chart = parseSequence(snapshot);
      nextCleanup = await host.draw(snapshot, staging);
      while (!disposed && current === revision && textBox) await new Promise(resolve => setTimeout(resolve, 40));
      if (disposed || current !== revision) return;
      const drawn = staging.querySelector<SVGSVGElement>('svg');
      if (!drawn) throw new Error('Mermaid 没有生成图。');
      const tagged = tagSequenceSvg(drawn, chart);
      messagesTagged = tagged.messages;
      const view = doc.createElement('div'); view.className = 'mp-editor-diagram mp-diagram-surface';
      view.style.backgroundColor = drawn.dataset.mpBackground ?? '';
      stage.style.backgroundColor = drawn.dataset.mpBackground ?? '';
      copyCanvasTone(staging, root);
      view.append(...staging.childNodes);
      cleanup?.(); cleanup = nextCleanup; nextCleanup = undefined;
      for (const child of [...canvas.children]) if (child !== overlay) child.remove();
      canvas.prepend(view);
      displayedSource = snapshot;
      const keep: LocalState = {};
      if (state.node && chart.participants.some(item => item.id === state.node)) keep.node = state.node;
      if (state.edge !== undefined && chart.messages[state.edge]) keep.edge = state.edge;
      if (state.note !== undefined && chart.notes[state.note]) keep.note = state.note;
      select(keep);
      const reason = structuralBlock(chart);
      const parts = [reason, !tagged.messages && chart.messages.length ? '有些消息点不中，可以直接改源码。' : '', !tagged.participants && chart.participants.length ? '有些参与者点不中，可以直接改源码。' : ''].filter(Boolean);
      say(parts.length ? parts.join(' ') : hint);
      if (focusText) startText();
    } catch (error) {
      if (disposed || current !== revision) return;
      if (displayedSource === snapshot) displayedSource = '';
      say(`无法编辑：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      nextCleanup?.(); staging.remove();
      doc.defaultView?.requestAnimationFrame(() => {
        if (!disposed && current === revision) canvas.style.minHeight = '';
      });
    }
  }

  async function apply(edit: (source: string) => EditResult, focusText = false) {
    if (busy) return;
    let result: EditResult;
    try { result = edit(source); } catch (error) { say(error instanceof Error ? error.message : String(error)); return; }
    if (result.source === source) return;
    const shown = source;
    busy = true; syncButtons();
    try {
      const ok = await host.commit(shown, result.source);
      if (disposed) return;
      if (!ok) { say('这个代码块在别处被改过了，这次没有写入。请退出后重新编辑。'); return; }
      source = result.source;
      state = { node: result.select?.node, edge: result.select?.edge, editing: focusText };
      host.remember?.(publicState());
    } finally { busy = false; syncButtons(); }
    await render(focusText);
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
    if (locked()) { say(locked()!); return; }
    if (state.node !== undefined) { const id = state.node; void apply(s => deleteParticipant(s, id)); }
    else if (state.edge !== undefined) { const index = state.edge; void apply(s => deleteMessage(s, index)); }
    else if (state.note !== undefined) say('注释只能改文字，不能删除。');
  }

  function textTarget(): Element | null {
    if (state.node !== undefined) return nodeEls(state.node).find(el => el.getAttribute('data-et') === 'participant') ?? nodeEls(state.node)[0] ?? null;
    if (state.edge !== undefined) return edgeEls(state.edge).find(el => el.classList.contains('messageText')) ?? edgeEls(state.edge).find(el => !el.classList.contains('mp-edge-hit')) ?? null;
    if (state.note !== undefined) return noteEls(state.note).find(el => el.querySelector('.noteText')) ?? noteEls(state.note)[0] ?? null;
    return null;
  }

  function currentRaw(): string | undefined {
    const chart = chartOf();
    if (!chart) return undefined;
    if (state.node !== undefined) return chart.participants.find(item => item.id === state.node)?.raw;
    if (state.edge !== undefined) return chart.messages[state.edge]?.raw;
    if (state.note !== undefined) return chart.notes[state.note]?.raw;
    return undefined;
  }

  function startText() {
    if (busy || (state.node === undefined && state.edge === undefined && state.note === undefined)) return;
    closeText(false);
    const raw = currentRaw();
    const target = textTarget();
    if (raw === undefined || !target) return;
    const b = box(target);
    const input = doc.createElement('textarea');
    input.className = 'mp-editor-text';
    input.setAttribute('aria-label', state.node !== undefined ? '参与者文字' : state.edge !== undefined ? '消息文字' : '注释文字');
    input.value = editText(raw);
    const width = Math.max(140, b.width), height = Math.max(44, b.height);
    input.style.left = `${b.x + b.width / 2 - width / 2}px`;
    input.style.top = `${b.y + b.height / 2 - height / 2}px`;
    input.style.width = `${width}px`; input.style.height = `${height}px`;
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); closeText(true); }
      else if (event.key === 'Escape') { event.preventDefault(); closeText(false); root.focus({ preventScroll: true }); }
    });
    input.addEventListener('blur', () => { if (textBox === input) closeText(true); });
    menu.hidden = true;
    overlay.append(input); textBox = input;
    input.focus({ preventScroll: true }); input.select();
  }

  function closeText(save: boolean) {
    const input = textBox;
    if (!input) return;
    textBox = undefined; input.remove();
    if (!save) { place(); return; }
    const text = input.value;
    const raw = currentRaw();
    if (raw !== undefined && editText(raw) === text.trim() && text.trim()) { place(); return; }
    if (state.node !== undefined) { const id = state.node; void apply(s => setParticipantLabel(s, id, text)); }
    else if (state.edge !== undefined) { const index = state.edge; void apply(s => setMessageText(s, index, text)); }
    else if (state.note !== undefined) { const index = state.note; void apply(s => setNoteText(s, index, text)); }
  }

  function hitAt(target: EventTarget | null): LocalState | 'control' | null {
    const el = target as Element | null;
    if (!el?.closest || !canvas.contains(el) || overlay.contains(el)) return null;
    const control = el.closest('[data-et="control-structure"]');
    const marked = el.closest('[data-node-id], [data-edge-index], [data-note-index]');
    if (control && (!marked || control.contains(marked))) return 'control';
    if (!marked) return null;
    const node = marked.getAttribute('data-node-id');
    if (node !== null && marked.getAttribute('data-et') !== 'life-line') return { node };
    const edge = marked.getAttribute('data-edge-index');
    if (edge !== null) return { edge: Number(edge) };
    const note = marked.getAttribute('data-note-index');
    if (note !== null) return { note: Number(note) };
    if (node !== null) return { node };
    return null;
  }

  for (const type of ['mousedown', 'pointerdown', 'pointerup', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'input', 'beforeinput'] as const) {
    root.addEventListener(type, event => event.stopPropagation());
  }
  root.addEventListener('mousedown', event => {
    if (!(event.target as Element).closest('textarea')) { event.preventDefault(); if (!textBox) root.focus({ preventScroll: true }); }
  });

  stage.addEventListener('click', event => {
    const target = event.target as Element;
    if (menu.contains(target) || target.closest('textarea') || frame.contains(target)) return;
    const hit = hitAt(target);
    if (hit === 'control') { say('暂不能改。'); return; }
    if (!messagesTagged && hit && hit.edge !== undefined) { say('有些消息点不中，可以直接改源码。'); return; }
    select(hit ?? {});
  });
  stage.addEventListener('dblclick', event => {
    const target = event.target as Element;
    if (menu.contains(target) || textBox) return;
    if (frame.contains(target)) { startText(); return; }
    const hit = hitAt(target);
    if (hit === 'control') { say('暂不能改。'); return; }
    if (!hit) return;
    if (!messagesTagged && hit.edge !== undefined) { say('有些消息点不中，可以直接改源码。'); return; }
    select(hit); startText();
  });

  root.addEventListener('keydown', event => {
    if (event.target !== root) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); void history(event.shiftKey ? 'redo' : 'undo'); }
    else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); void history('redo'); }
    else if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); startText(); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelection(); }
    else if (event.key === 'ArrowLeft' && state.node) { event.preventDefault(); void apply(s => moveParticipant(s, state.node!, -1)); }
    else if (event.key === 'ArrowRight' && state.node) { event.preventDefault(); void apply(s => moveParticipant(s, state.node!, 1)); }
    else if (event.key === 'ArrowUp' && state.edge !== undefined) { event.preventDefault(); void apply(s => moveMessage(s, state.edge!, -1)); }
    else if (event.key === 'ArrowDown' && state.edge !== undefined) { event.preventDefault(); void apply(s => moveMessage(s, state.edge!, 1)); }
    else if (event.key === 'Escape') {
      event.preventDefault();
      if (state.node !== undefined || state.edge !== undefined || state.note !== undefined) select({});
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
    update(next, nextState) {
      const draft = textBox?.value;
      const editing = !!(textBox && draft !== undefined && editText(currentRaw() ?? '') !== draft.trim());
      if (next !== source && textBox) closeText(false);
      source = next; if (nextState) state = { node: nextState.node, edge: nextState.edge };
      else if (editing) state = { ...state, editing: true };
      void render(nextState?.editing || editing).then(() => {
        if (!editing || draft === undefined || disposed || !textBox) return;
        textBox.value = draft;
        say('源码已在别处修改，正在输入的文字已保留，按 Enter 再试一次。');
      });
    },
    source: () => source,
    adopt(next) {
      if (root.parentElement === next) return;
      const refocus = focused && !textBox;
      next.append(root);
      if (refocus) root.focus({ preventScroll: true });
      place();
    },
    dispose() {
      disposed = true; revision++; textBox = undefined; pendingRender = undefined;
      clearTimeout(renderTimer); renderWaiters.splice(0).forEach(resolve => resolve());
      resize?.disconnect(); cleanup?.(); root.remove();
    },
  };
}
