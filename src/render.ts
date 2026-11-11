// 用途：根据样式注释测量节点文字并生成安全的矢量流程图，不执行标签中的 HTML。
import dagre from '@dagrejs/dagre';
import { readAnnotations, resolveStyles } from './annotations';
import { parseFlowchart } from './flowchart';

let serial = 0;
const svgNS = 'http://www.w3.org/2000/svg';

export function renderEnhanced(container: HTMLElement, source: string): string[] {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const chart = parseFlowchart(source);
  const { annotations, warnings } = readAnnotations(source);
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: chart.direction, nodesep: 36, ranksep: 72, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));
  const labels = new Map<string, HTMLDivElement>();
  const measuring = doc.createElement('div');
  measuring.className = 'mp-measuring';
  container.append(measuring);
  try {
    for (const node of chart.nodes) {
      const label = doc.createElement('div');
      label.className = 'mp-node-label';
      label.style.width = 'max-content';
      const annotation = annotations.find(a => a.node === node.id);
      let styles = annotation?.styles ?? [];
      if (annotation && annotation.label !== node.label) {
        warnings.push(`节点 ${node.id} 的原始文字已变化，样式已跳过。`); styles = [];
      }
      const resolved = resolveStyles(node.label, styles);
      warnings.push(...resolved.warnings.map(w => `${node.id}：${w}`));
      for (const segment of resolved.segments) {
        const span = doc.createElement('span');
        span.textContent = segment.text;
        for (const type of segment.types) span.classList.add(`mp-style-${type}`);
        label.append(span);
      }
      measuring.append(label);
      const width = Math.max(80, Math.max(label.offsetWidth, label.scrollWidth) + 32);
      const height = Math.max(52, Math.max(label.offsetHeight, label.scrollHeight) + 24);
      const factor = node.shape === 'diamond' ? 1.65 : 1;
      graph.setNode(node.id, { width: width * factor, height: height * factor });
      labels.set(node.id, label);
    }
    for (const a of annotations) if (!labels.has(a.node)) warnings.push(`找不到节点 ${a.node}，样式已跳过。`);
    chart.edges.forEach((edge, index) => graph.setEdge(edge.from, edge.to, {
      label: edge.label, width: edge.label.length * 14, height: edge.label ? 24 : 0,
    }, String(index)));
    dagre.layout(graph);
    const svg = doc.createElementNS(svgNS, 'svg');
    svg.classList.add('mp-diagram');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '注释样式增强流程图');
    const size = graph.graph();
    svg.setAttribute('viewBox', `0 0 ${size.width ?? 1} ${size.height ?? 1}`);
    svg.style.maxWidth = `${size.width}px`;
    const make = (tag: string, attrs: Record<string, string | number>) => {
      const element = doc.createElementNS(svgNS, tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      return element;
    };
    const arrowId = `mp-arrow-${++serial}`;
    const defs = make('defs', {}), marker = make('marker', {
      id: arrowId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    });
    marker.append(make('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor' }));
    defs.append(marker); svg.append(defs);
    chart.edges.forEach((edge, index) => {
      const layout = graph.edge({ v: edge.from, w: edge.to, name: String(index) });
      const points: { x: number; y: number }[] = layout.points.map((p: { x: number; y: number }) => ({ ...p }));
      // 布局器按矩形边界截线；菱形需要重新计算与实际边框的交点。
      for (const [id, endpoint, neighbor] of [[edge.from, 0, 1], [edge.to, points.length - 1, points.length - 2]] as const) {
        if (chart.nodes.find(n => n.id === id)?.shape !== 'diamond') continue;
        const box = graph.node(id), toward = points[neighbor];
        if (!toward) continue;
        const dx = toward.x - box.x, dy = toward.y - box.y;
        const divisor = Math.abs(dx) / (box.width / 2) + Math.abs(dy) / (box.height / 2);
        if (divisor > 0) points[endpoint] = { x: box.x + dx/divisor, y: box.y + dy/divisor };
      }
      const path = make('path', { d: points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '), class: 'mp-edge' });
      if (edge.arrow) path.setAttribute('marker-end', `url(#${arrowId})`);
      svg.append(path);
      if (edge.label) {
        const text = make('text', { x: layout.x ?? 0, y: layout.y ?? 0, class: 'mp-edge-label', 'text-anchor': 'middle' });
        text.textContent = edge.label; svg.append(text);
      }
    });
    for (const node of chart.nodes) {
      const box = graph.node(node.id);
      const group = make('g', { 'data-node-id': node.id, transform: `translate(${box.x - box.width/2},${box.y - box.height/2})` });
      const shape = node.shape === 'diamond'
        ? make('polygon', { points: `${box.width/2},0 ${box.width},${box.height/2} ${box.width/2},${box.height} 0,${box.height/2}`, class: 'mp-node-shape' })
        : make('rect', { width: box.width, height: box.height, rx: node.shape === 'round' ? 20 : 6, class: 'mp-node-shape' });
      group.append(shape);
      const foreign = make('foreignObject', { x: 0, y: 0, width: box.width, height: box.height });
      const holder = doc.createElement('div'); holder.className = 'mp-node-content';
      const label = labels.get(node.id)!; label.style.removeProperty('width');
      holder.append(label); foreign.append(holder); group.append(foreign); svg.append(group);
    }
    container.append(svg);
  } finally { measuring.remove(); }
  return warnings;
}
