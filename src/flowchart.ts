// 用途：为注释样式实验读取有限的流程图语法，遇到未知语法立即停止增强渲染。
export interface FlowNode { id: string; label: string; shape: 'rect' | 'round' | 'diamond' }
export interface FlowEdge { from: string; to: string; label: string; arrow: boolean }
export interface Flowchart { direction: string; nodes: FlowNode[]; edges: FlowEdge[] }

export function parseFlowchart(source: string): Flowchart {
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('%%'));
  const header = lines.shift()?.match(/^(?:flowchart|graph)\s+(LR|RL|TB|TD|BT)\s*;?$/);
  if (!header) throw new Error('实验版仅支持 flowchart / graph 流程图。');
  const nodes = new Map<string, FlowNode>(), edges: FlowEdge[] = [];
  function endpoint(text: string): { id: string; rest: string } {
    const match = text.match(/^([A-Za-z]\w*)(?:\["([^"\n]*)"\]|\[([^\]\n]+)\]|\("([^"\n]*)"\)|\{"([^"\n]*)"\})?/);
    if (!match || match[1] === 'end') throw new Error('遇到尚不支持的节点语法。');
    const id = match[1]!;
    const explicit = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (explicit !== undefined && /[<>#`]/.test(explicit)) throw new Error('实验版只增强普通文字标签；HTML、实体或 Markdown 标签保留原生预览。');
    if (explicit !== undefined || !nodes.has(id)) nodes.set(id, {
      id, label: explicit ?? id, shape: match[4] !== undefined ? 'round' : match[5] !== undefined ? 'diamond' : 'rect',
    });
    return { id, rest: text.slice(match[0].length).trim() };
  }
  for (const line of lines) {
    let current = endpoint(line);
    while (current.rest) {
      if (/^---[ox]/.test(current.rest)) throw new Error('实验版暂不支持圆头或叉头连线，请保留原生预览。');
      const edge = current.rest.match(/^(-->|---)\s*(?:\|([^|]*)\|\s*)?/);
      if (!edge) throw new Error(`暂不增强这行语法：${line}`);
      const next = endpoint(current.rest.slice(edge[0].length));
      edges.push({ from: current.id, to: next.id, label: edge[2] ?? '', arrow: edge[1] === '-->' });
      current = next;
    }
  }
  if (!nodes.size) throw new Error('流程图中没有节点。');
  if (nodes.size > 150 || edges.length > 300) throw new Error('实验版限制为 150 个节点、300 条连线。');
  return { direction: header[1] === 'TD' ? 'TB' : header[1]!, nodes: [...nodes.values()], edges };
}

export function findMermaidBlocks(markdown: string) {
  const lines = markdown.split(/\r?\n/), blocks: { source: string; start: number; end: number }[] = [];
  let fence: string | undefined, start = 0, capture = false;
  for (let i = 0; i < lines.length; i++) {
    if (!fence) {
      const match = lines[i]!.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
      if (match) { fence = match[1]!; start = i; capture = match[2]!.trim() === 'mermaid'; }
    } else if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i]!)) {
      if (capture) blocks.push({ source: lines.slice(start + 1, i).join('\n'), start, end: i });
      fence = undefined;
    }
  }
  return blocks;
}
