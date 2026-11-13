// 用途：手动调整的节点位置。位置以“相对自动排版的偏移”保存在一行 `%% mermaid-plus-layout: {...}` 注释中，
// Mermaid 把它当作注释忽略；插件在 Mermaid 画完后移动这些节点，并重画与之相连的连线、撑开所在子图。
import type { Flowchart } from './flowchart';
import { avoidText, applyLineHops, shiftPath } from './edgeAvoid';

export interface ManualLayout { version: 1; nodes: Record<string, [number, number]> }
const LINE = /^\s*%% mermaid-plus-layout:\s*(.*)$/;
const ID = /^[A-Za-z_][\w-]*$/;

/** 读出源码里的位置注释；没有或损坏时返回空布局（损坏的注释在下次写入时被替换）。 */
export function readLayout(source: string): ManualLayout {
  const empty: ManualLayout = { version: 1, nodes: {} };
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(LINE);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]!) as Partial<ManualLayout>;
      if (value.version !== 1 || !value.nodes || typeof value.nodes !== 'object') return empty;
      const nodes: ManualLayout['nodes'] = {};
      for (const [id, offset] of Object.entries(value.nodes)) {
        if (ID.test(id) && Array.isArray(offset) && offset.length === 2 && offset.every(n => typeof n === 'number' && Number.isFinite(n))) nodes[id] = [offset[0]!, offset[1]!];
      }
      return { version: 1, nodes };
    } catch { return empty; }
  }
  return empty;
}

/** 写入整份位置；没有任何偏移时删掉注释行。只改这一行（没有时追加在末尾），其他行原样保留。 */
export function writeLayout(source: string, nodes: ManualLayout['nodes']): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const kept = Object.entries(nodes).filter(([, [x, y]]) => Math.round(x) !== 0 || Math.round(y) !== 0)
    .map(([id, [x, y]]) => [id, [Math.round(x), Math.round(y)]] as const);
  const at = lines.findIndex(line => LINE.test(line));
  if (!kept.length) {
    if (at >= 0) lines.splice(at, 1);
    return lines.join(eol);
  }
  const text = `%% mermaid-plus-layout: ${JSON.stringify({ version: 1, nodes: Object.fromEntries(kept) })}`;
  if (at >= 0) { lines[at] = lines[at]!.match(/^\s*/)![0] + text; return lines.join(eol); }
  // 追加在末尾；源码以空行结尾时放在空行之前。
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  const indent = lines.slice(1, end).find(line => line.trim())?.match(/^\s*/)![0] ?? '';
  lines.splice(end, 0, indent + text);
  return lines.join(eol);
}

/** 把某个节点的偏移设为 (dx, dy)；(0, 0) 表示回到自动位置。 */
export function setNodeOffset(source: string, id: string, dx: number, dy: number): string {
  const { nodes } = readLayout(source);
  return writeLayout(source, { ...nodes, [id]: [dx, dy] });
}

/** 去掉一个节点（id 给定时）或全部节点的手动位置。 */
export function clearLayout(source: string, id?: string): string {
  if (id === undefined) return writeLayout(source, {});
  const { nodes } = readLayout(source);
  if (!(id in nodes)) return source;
  delete nodes[id];
  return writeLayout(source, nodes);
}

// ———— 画面上的调整 ————

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }
/** Mermaid 把连线终点停在节点边框外 4px，箭头标记补上这段。 */
const ARROW_GAP = 4;

/** 两个框之间的连线：沿间隔更大的方向出发；对得上时画直线，否则走 Z 字形（直角）或平滑曲线。 */
export function routeEdge(from: Box, to: Box, orthogonal: boolean, gaps = { start: 0, end: ARROW_GAP }) {
  const a = edges(from), b = edges(to);
  const gapY = Math.max(b.top - a.bottom, a.top - b.bottom);
  const gapX = Math.max(b.left - a.right, a.left - b.right);
  const vertical = gapY >= gapX;
  let s: Point, e: Point;
  if (vertical) {
    const down = b.cy >= a.cy;
    // 横向有重叠时在重叠段中间直连，不拐弯。
    const lo = Math.max(a.left, b.left), hi = Math.min(a.right, b.right);
    const shared = hi - lo >= 16 ? (lo + hi) / 2 : undefined;
    s = { x: shared ?? a.cx, y: down ? a.bottom : a.top };
    e = { x: shared ?? b.cx, y: down ? b.top : b.bottom };
    const sign = down ? 1 : -1;
    s.y += sign * gaps.start; e.y -= sign * gaps.end;
  } else {
    const right = b.cx >= a.cx;
    const lo = Math.max(a.top, b.top), hi = Math.min(a.bottom, b.bottom);
    const shared = hi - lo >= 12 ? (lo + hi) / 2 : undefined;
    s = { x: right ? a.right : a.left, y: shared ?? a.cy };
    e = { x: right ? b.left : b.right, y: shared ?? b.cy };
    const sign = right ? 1 : -1;
    s.x += sign * gaps.start; e.x -= sign * gaps.end;
  }
  const f = (p: Point) => `${round(p.x)},${round(p.y)}`;
  const straight = vertical ? Math.abs(s.x - e.x) < 0.5 : Math.abs(s.y - e.y) < 0.5;
  if (straight) return { d: `M${f(s)}L${f(e)}`, label: mid(s, e) };
  if (orthogonal) {
    const points = vertical
      ? [s, { x: s.x, y: (s.y + e.y) / 2 }, { x: e.x, y: (s.y + e.y) / 2 }, e]
      : [s, { x: (s.x + e.x) / 2, y: s.y }, { x: (s.x + e.x) / 2, y: e.y }, e];
    return { d: `M${points.map(f).join('L')}`, label: mid(points[1]!, points[2]!) };
  }
  const c1 = vertical ? { x: s.x, y: (s.y + e.y) / 2 } : { x: (s.x + e.x) / 2, y: s.y };
  const c2 = vertical ? { x: e.x, y: (s.y + e.y) / 2 } : { x: (s.x + e.x) / 2, y: e.y };
  return { d: `M${f(s)}C${f(c1)},${f(c2)},${f(e)}`, label: mid(s, e) };
}

function edges(b: Box) {
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const round = (n: number) => Math.round(n * 10) / 10;

function translateOf(el: Element): Point {
  const m = el.getAttribute('transform')?.match(/translate\(\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)\s*\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}
/** 元素自身坐标原点在 svg 坐标中的位置（Mermaid 的分组只用平移）。 */
function originOf(el: Element, svg: SVGSVGElement): Point {
  let x = 0, y = 0;
  for (let p = el.parentElement; p && p !== (svg as Element); p = p.parentElement) { const t = translateOf(p); x += t.x; y += t.y; }
  return { x, y };
}

interface NodeItem { g: SVGGElement; base: Point; origin: Point; local: Box }
interface EdgeItem { path: SVGPathElement; from: string; to: string; label?: SVGGElement; labelBase?: Point; d: string; style: string }
interface GroupItem { id: string; rect: SVGRectElement; base: Box; label?: SVGGElement; labelBase?: Point; pad: { left: number; right: number; top: number; bottom: number }; members: string[]; groups: string[] }

export interface Mover {
  /** 按给定偏移摆放所有节点（未列出的节点回到自动位置）；fit 为 true 时同时调整画布大小。 */
  move(offsets: ManualLayout['nodes'], fit?: boolean): void;
  /** 节点当前在 svg 坐标中的外框。 */
  box(id: string): Box | undefined;
}

/**
 * 为一张已渲染（并已放进页面，能量尺寸）的流程图建立移动器。自动位置记在元素的 data-mp-* 属性上，
 * 所以对同一张图重复调用也能回到原位。连线与源码对不上时只移动节点、不重画连线。
 */
export function createMover(svg: SVGSVGElement, chart: Flowchart): Mover {
  const orthogonal = svg.dataset.mpEdges !== 'curved';
  const nodes = new Map<string, NodeItem>();
  const ids = new Set(chart.nodes.map(n => n.id));
  for (const g of svg.querySelectorAll<SVGGElement>('g.node')) {
    const dataId = g.getAttribute('data-id');
    const id = dataId && ids.has(dataId) ? dataId : g.id.match(/flowchart-(.+)-\d+$/)?.[1];
    if (!id || !ids.has(id) || nodes.has(id)) continue;
    g.dataset.mpBase ??= JSON.stringify(translateOf(g));
    const base = JSON.parse(g.dataset.mpBase) as Point;
    let local: Box;
    try { const b = g.getBBox(); local = { x: b.x, y: b.y, width: b.width, height: b.height }; } catch { local = { x: 0, y: 0, width: 0, height: 0 }; }
    nodes.set(id, { g, base, origin: originOf(g, svg), local });
  }

  const paths = [...svg.querySelectorAll<SVGPathElement>('path.flowchart-link, .edgePaths > path')].filter((p, i, all) => !p.classList.contains('mp-edge-hit') && all.indexOf(p) === i);
  const edgeItems: EdgeItem[] = [];
  if (paths.length === chart.edges.length) {
    const labels = [...svg.querySelectorAll<SVGGElement>('.edgeLabels > .edgeLabel')];
    const labelOf = (path: SVGPathElement) => {
      const dataId = path.getAttribute('data-id');
      return dataId ? labels.find(l => l.querySelector(`[data-id="${CSS.escape(dataId)}"]`)) : undefined;
    };
    paths.forEach((path, i) => {
      path.dataset.mpAutoD ??= path.getAttribute('d') ?? '';
      path.dataset.mpAutoStyle ??= path.getAttribute('style') ?? '';
      const label = labelOf(path);
      if (label) label.dataset.mpBase ??= JSON.stringify(translateOf(label));
      edgeItems.push({ path, from: chart.edges[i]!.from, to: chart.edges[i]!.to, label, labelBase: label ? JSON.parse(label.dataset.mpBase!) as Point : undefined, d: path.dataset.mpAutoD, style: path.dataset.mpAutoStyle });
    });
  }

  // 子图：框随成员移动而撑开或收拢，保持原来的四边留白。
  const groups: GroupItem[] = [];
  const nodeBoxAt = (id: string, offset: Point = { x: 0, y: 0 }): Box | undefined => {
    const n = nodes.get(id);
    if (!n) return undefined;
    return { x: n.origin.x + n.base.x + offset.x + n.local.x, y: n.origin.y + n.base.y + offset.y + n.local.y, width: n.local.width, height: n.local.height };
  };
  for (const group of chart.groups) {
    const g = [...svg.querySelectorAll<SVGGElement>('g.cluster')].find(c => c.getAttribute('data-id') === group.id || c.id === group.id || c.id.endsWith(`-${group.id}`));
    const rect = g?.querySelector<SVGRectElement>(':scope > rect');
    if (!g || !rect) continue;
    rect.dataset.mpBase ??= JSON.stringify({ x: +rect.getAttribute('x')!, y: +rect.getAttribute('y')!, width: +rect.getAttribute('width')!, height: +rect.getAttribute('height')! });
    const origin = originOf(rect, svg);
    const local = JSON.parse(rect.dataset.mpBase) as Box;
    const base = { ...local, x: local.x + origin.x, y: local.y + origin.y };
    const label = g.querySelector<SVGGElement>(':scope > .cluster-label') ?? undefined;
    if (label) label.dataset.mpBase ??= JSON.stringify(translateOf(label));
    const members = chart.nodes.filter(n => n.parent === group.id).map(n => n.id);
    const childGroups = chart.groups.filter(c => c.parent === group.id).map(c => c.id);
    groups.push({ id: group.id, rect, base, label, labelBase: label ? JSON.parse(label.dataset.mpBase!) as Point : undefined, members, groups: childGroups, pad: { left: 0, right: 0, top: 0, bottom: 0 } });
  }
  const depth = (id: string): number => { const p = chart.groups.find(g => g.id === id)?.parent; return p ? depth(p) + 1 : 0; };
  groups.sort((a, b) => depth(b.id) - depth(a.id)); // 先算里层
  const union = (boxes: Box[]): Box | undefined => {
    if (!boxes.length) return undefined;
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
  };
  // 原始留白 = 原框与成员（自动位置）外框之差。
  const autoGroupBox = new Map<string, Box>();
  for (const group of groups) {
    autoGroupBox.set(group.id, group.base);
    const content = union([...group.members.map(id => nodeBoxAt(id)!).filter(Boolean), ...group.groups.map(id => autoGroupBox.get(id)!).filter(Boolean)]);
    if (content) group.pad = { left: content.x - group.base.x, top: content.y - group.base.y, right: group.base.x + group.base.width - content.x - content.width, bottom: group.base.y + group.base.height - content.y - content.height };
  }

  const viewBase = svg.dataset.mpViewBox ??= svg.getAttribute('viewBox') ?? '';
  let current: ManualLayout['nodes'] = {};
  const offsetOf = (id: string): Point => { const o = current[id]; return o ? { x: o[0], y: o[1] } : { x: 0, y: 0 }; };

  function move(offsets: ManualLayout['nodes'], fit = true) {
    current = offsets;
    for (const [id, n] of nodes) {
      const o = offsetOf(id);
      n.g.setAttribute('transform', `translate(${n.base.x + o.x}, ${n.base.y + o.y})`);
    }
    // 子图
    const groupBox = new Map<string, Box>();
    const movedInside = (group: GroupItem): boolean => group.members.some(id => current[id]) || group.groups.some(id => { const g = groups.find(x => x.id === id); return g ? movedInside(g) : false; });
    for (const group of groups) {
      let box = group.base;
      if (movedInside(group)) {
        const content = union([...group.members.map(id => nodeBoxAt(id, offsetOf(id))!).filter(Boolean), ...group.groups.map(id => groupBox.get(id)!).filter(Boolean)]);
        if (content) box = { x: content.x - group.pad.left, y: content.y - group.pad.top, width: content.width + group.pad.left + group.pad.right, height: content.height + group.pad.top + group.pad.bottom };
      }
      groupBox.set(group.id, box);
      const origin = { x: group.base.x - (JSON.parse(group.rect.dataset.mpBase!) as Box).x, y: group.base.y - (JSON.parse(group.rect.dataset.mpBase!) as Box).y };
      group.rect.setAttribute('x', String(box.x - origin.x)); group.rect.setAttribute('y', String(box.y - origin.y));
      group.rect.setAttribute('width', String(box.width)); group.rect.setAttribute('height', String(box.height));
      if (group.label && group.labelBase) {
        const dx = (box.x + box.width / 2) - (group.base.x + group.base.width / 2), dy = box.y - group.base.y;
        group.label.setAttribute('transform', `translate(${group.labelBase.x + dx}, ${group.labelBase.y + dy})`);
      }
    }
    // 连线：两端都在自动位置的保持 Mermaid 原样，其余重画。
    const endpoint = (id: string) => nodeBoxAt(id, offsetOf(id)) ?? groupBox.get(id);
    for (const edge of edgeItems) {
      const hit = edge.path.nextElementSibling?.classList.contains('mp-edge-hit') ? edge.path.nextElementSibling : null;
      const touched = current[edge.from] || current[edge.to] || [edge.from, edge.to].some(id => groups.find(g => g.id === id && movedInside(g)));
      if (touched && edge.from === edge.to) {
        const offset = offsetOf(edge.from), d = shiftPath(edge.d, offset.x, offset.y);
        edge.path.setAttribute('d', d); hit?.setAttribute('d', d);
        if (edge.label && edge.labelBase) edge.label.setAttribute('transform', `translate(${edge.labelBase.x + offset.x}, ${edge.labelBase.y + offset.y})`);
        continue;
      }
      if (!touched) {
        edge.path.setAttribute('d', edge.d); edge.path.setAttribute('style', edge.style); hit?.setAttribute('d', edge.d);
        if (edge.label && edge.labelBase) edge.label.setAttribute('transform', `translate(${edge.labelBase.x}, ${edge.labelBase.y})`);
        continue;
      }
      const a = endpoint(edge.from), b = endpoint(edge.to);
      if (!a || !b) continue;
      const origin = originOf(edge.path, svg);
      const route = routeEdge(a, b, orthogonal, { start: edge.path.hasAttribute('marker-start') ? ARROW_GAP : 0, end: edge.path.hasAttribute('marker-end') ? ARROW_GAP : 0 });
      const d = origin.x || origin.y ? shiftPath(route.d, -origin.x, -origin.y) : route.d;
      edge.path.setAttribute('d', d); hit?.setAttribute('d', d);
      // Mermaid 用 “0 0 长度-4 4” 的虚线让线在箭头前停下；改了路径要按新长度重算。
      const dash = edge.style.match(/stroke-dasharray:\s*0 0 [\d.]+ (\d+(?:\.\d+)?)/);
      if (dash) {
        let length = 0;
        try { length = edge.path.getTotalLength(); } catch { /* 未放进页面时量不到 */ }
        edge.path.setAttribute('style', edge.style.replace(dash[0], `stroke-dasharray: 0 0 ${Math.max(0, length - Number(dash[1]))} ${dash[1]}`));
      }
      if (edge.label) {
        const lo = originOf(edge.label, svg);
        edge.label.setAttribute('transform', `translate(${route.label.x - lo.x}, ${route.label.y - lo.y})`);
      }
    }
    if (fit) fitView();
    // 重画后的连线和回到原样的连线都可能压到挪过的节点文字，统一再避让一次（在定好画布之后，绕出去的线再撑开画布）。
    try { avoidText(svg, fit); if (fit) applyLineHops(svg); } catch { /* 保留上面算出的连线 */ }
  }

  /** 画布包住所有内容，四周留白与 Mermaid 原来的一样。 */
  function fitView() {
    const [vx, vy, vw, vh] = viewBase.split(/[\s,]+/).map(Number);
    if (![vx, vy, vw, vh].every(n => Number.isFinite(n))) return;
    const autoContent = union([...nodes.keys()].map(id => nodeBoxAt(id)!).concat(groups.map(g => g.base)).filter(Boolean));
    const content = union([...nodes.keys()].map(id => nodeBoxAt(id, offsetOf(id))!).concat(groups.map(g => {
      const r = g.rect; const o = originOf(r, svg);
      return { x: +r.getAttribute('x')! + o.x, y: +r.getAttribute('y')! + o.y, width: +r.getAttribute('width')!, height: +r.getAttribute('height')! };
    })).filter(Boolean));
    if (!autoContent || !content) return;
    const left = autoContent.x - vx!, top = autoContent.y - vy!;
    const right = vx! + vw! - autoContent.x - autoContent.width, bottom = vy! + vh! - autoContent.y - autoContent.height;
    // 连线可能伸出节点外框（例如绕行），所以只扩大不缩到比内容更小。
    const x = Math.min(vx!, content.x - left), y = Math.min(vy!, content.y - top);
    const w = Math.max(vx! + vw!, content.x + content.width + right) - x, h = Math.max(vy! + vh!, content.y + content.height + bottom) - y;
    const anyMoved = Object.keys(current).length > 0;
    const view = anyMoved ? { x: content.x - left, y: content.y - top, w: content.width + left + right, h: content.height + top + bottom } : { x, y, w, h };
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    if (svg.style.maxWidth) svg.style.maxWidth = `${view.w}px`;
    if (svg.dataset.mpMinScale) svg.style.minWidth = `${view.w * Number(svg.dataset.mpMinScale)}px`;
  }

  return { move, box: id => nodeBoxAt(id, offsetOf(id)) ?? (() => { const g = groups.find(x => x.id === id); return g ? g.base : undefined; })() };
}

/** 按源码中的位置注释调整一张刚渲染的图；没有注释时什么都不做。 */
export function applyManualLayout(svg: SVGSVGElement, chart: Flowchart, layout: ManualLayout) {
  if (!Object.keys(layout.nodes).length) return;
  createMover(svg, chart).move(layout.nodes, true);
}
