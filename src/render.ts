// 用途：根据样式注释测量节点文字并生成安全的矢量流程图，不执行标签中的 HTML。
import { readAnnotations, resolveStyles } from './annotations';
import { parseFlowchart } from './flowchart';
import { edgePath, defaultLayoutSettings, type LayoutSettings, type Size } from './layout';
import { layoutInWorker } from './layout-worker';

let serial = 0;
const svgNS = 'http://www.w3.org/2000/svg';

export async function renderEnhanced(container: HTMLElement, source: string, settings: LayoutSettings = defaultLayoutSettings, signal?: AbortSignal): Promise<string[]> {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const chart = parseFlowchart(source);
  const { annotations, warnings } = readAnnotations(source);
  const sizes = new Map<string, Size>();
  const labels = new Map<string, HTMLDivElement>();
  const measuring = doc.createElement('div');
  measuring.className = 'mp-measuring';
  container.append(measuring);
  try {
    for (const node of chart.nodes) {
      const label = doc.createElement('div');
      label.className = 'mp-node-label';
      label.style.width = 'max-content';
      label.style.maxWidth = node.shape === 'diamond' ? '180px' : '240px';
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
      const factor = node.shape === 'diamond' ? 2 : 1;
      sizes.set(node.id, { width: width * factor, height: height * factor });
      labels.set(node.id, label);
    }
    for (const a of annotations) if (!labels.has(a.node)) warnings.push(`找不到节点 ${a.node}，样式已跳过。`);
    const edgeSizes = chart.edges.map(edge => {
      const label = doc.createElement('span'); label.className = 'mp-edge-measure'; label.textContent = edge.label;
      measuring.append(label);
      return { width: label.offsetWidth + 12, height: label.offsetHeight + 8 };
    });
    const layout = await layoutInWorker(chart, sizes, edgeSizes, settings, { width: container.clientWidth || 600, height: 680 }, signal);
    const svg = doc.createElementNS(svgNS, 'svg');
    svg.classList.add('mp-diagram');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '注释样式增强流程图');
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    svg.style.maxWidth = `${layout.width}px`;
    // 大图最多缩小到 80%，剩余区域滚动查看，避免为了塞进半栏而让文字不可读。
    svg.style.width = `${Math.max(layout.width * .8, Math.min(layout.width, container.clientWidth || layout.width))}px`;
    svg.dataset.direction = layout.direction;
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
    for (const route of layout.edges) {
      const edge = chart.edges[route.index]!;
      const path = make('path', { d: edgePath(route.points, settings.lines === 'rounded' ? 8 : 0), class: 'mp-edge', 'data-edge-index': route.index });
      if (edge.arrow) path.setAttribute('marker-end', `url(#${arrowId})`);
      svg.append(path);
      if (edge.label && route.label) {
        const box = route.label;
        svg.append(make('rect', { x: box.x, y: box.y, width: box.width, height: box.height, rx: 4, class: 'mp-edge-label-bg' }));
        const text = make('text', { x: box.x + box.width/2, y: box.y + box.height/2, class: 'mp-edge-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        text.textContent = edge.label; svg.append(text);
      }
    }
    for (const node of chart.nodes) {
      const box = layout.nodes.find(box => box.id === node.id)!;
      const group = make('g', { 'data-node-id': node.id, transform: `translate(${box.x},${box.y})` });
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
