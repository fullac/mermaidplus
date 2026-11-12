// 用途：为增强渲染与可视化编辑读取常见的流程图语法（含子图、多种形状与线型），记录每个节点和连线在源码中的位置；遇到未知语法立即停止增强并说明是哪一行。
/** 源码中的一段位置：行号从 0 开始（相对代码块内容），列为该行内的字符偏移。 */
export interface Span { line: number; start: number; end: number }
/** 节点出现处；label 为方括号或圆括号内文字的位置（仅显式标签有）。 */
export interface NodeToken extends Span { id: string; label?: Span; quoted: boolean }
/** 一条连线的连接符（含可选 |文字|）位置。 */
export interface EdgeToken extends Span { edge: number }
/** 一行语句：节点与连线交替出现，nodes.length === edges.length + 1。 */
export interface Statement { line: number; nodes: NodeToken[]; edges: EdgeToken[] }
export type Shape = 'rect' | 'round' | 'diamond';
export interface FlowNode { id: string; label: string; raw: string; shape: Shape; parent?: string; def?: NodeToken }
/** link：去掉文字后的连接符（如 -->、-.->、==>），改写连线文字时沿用，保持线型不变。 */
export interface FlowEdge { from: string; to: string; label: string; raw: string; arrow: boolean; link: string; style: 'solid' | 'dotted' | 'thick'; token: EdgeToken }
export interface FlowGroup { id: string; title: string; parent?: string; line: number; endLine: number }
export interface Flowchart { direction: string; nodes: FlowNode[]; edges: FlowEdge[]; groups: FlowGroup[]; statements: Statement[] }

const lineBreak = /<br\s*\/?>/gi;
const entities: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'" };

/** 把源码标签转换为显示文字：<br> 换行，解码 #quot; 等实体，去掉常见的行内 HTML 标签与 Markdown 字符串反引号。显示时只作纯文字，不执行 HTML。 */
export function displayText(raw: string): string {
  let text = raw;
  const markdown = text.match(/^`([\s\S]*)`$/);
  if (markdown) text = markdown[1]!.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
  return text.replace(lineBreak, '\n')
    .replace(/<\/?(?:b|i|u|s|em|strong|code|mark|small|big|sub|sup|span|font|del|ins)(?:\s[^>]*)?>/gi, '')
    .replace(/#(\w+);/g, (all, name: string) => /^\d+$/.test(name) ? String.fromCodePoint(Number(name)) : entities[name.toLowerCase()] ?? all);
}

/** 编辑框中显示的文字：只把 <br/> 换成换行，Markdown 标签去掉外层反引号，其余原样保留，避免改字时丢掉原有格式。 */
export function editText(raw: string): string {
  const markdown = raw.match(/^`([\s\S]*)`$/);
  return (markdown ? markdown[1]! : raw).replace(lineBreak, '\n');
}

// 节点形状：按开头符号从长到短尝试。
const shapes: [string, string, Shape][] = [
  ['(((', ')))', 'round'], ['((', '))', 'round'], ['([', '])', 'round'], ['[[', ']]', 'rect'], ['[(', ')]', 'rect'],
  ['{{', '}}', 'rect'], ['[/', '/]', 'rect'], ['[/', '\\]', 'rect'], ['[\\', '\\]', 'rect'], ['[\\', '/]', 'rect'],
  ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diamond'], ['>', ']', 'rect'],
];
const idPattern = /^[\p{L}\p{N}_]+/u;
// 不带文字的连接符：实线 --> --- --o --x，虚线 -.-> -.-，粗线 ==> ===，可带 < 表示双向。
const plainLink = /^<?(?:-{2,}[>ox]|-{3,}|-\.+-[>ox]?|={2,}[>ox]|={3,})/;
// 文字写在线中间的形式：-- 文字 -->、-. 文字 .->、== 文字 ==>。
const textLink = /^(<?)(--|-\.|==)\s*([^\n]+?)\s*(-{2,}[>ox]|-{3,}|\.-+[>ox]?|={2,}[>ox]|={3,})/;
// 只影响外观、不影响结构的语句，原样保留在源码中，增强图忽略它们。
const passthrough = /^(?:classDef|class|style|linkStyle|click|accTitle|accDescr)\b/;

function styleOf(link: string): FlowEdge['style'] {
  return link.includes('.') ? 'dotted' : link.includes('=') ? 'thick' : 'solid';
}

export function parseFlowchart(source: string): Flowchart {
  const all = source.split(/\r?\n/);
  let first = all.findIndex(line => line.trim() && !line.trim().startsWith('%%'));
  // 跳过 Mermaid 的 YAML 前置配置（--- … ---）。
  if (first !== -1 && all[first]!.trim() === '---') {
    const close = all.findIndex((line, i) => i > first && line.trim() === '---');
    if (close === -1) throw new Error('图开头的 --- 配置缺少结束的 ---。');
    first = all.findIndex((line, i) => i > close && line.trim() && !line.trim().startsWith('%%'));
  }
  const header = first === -1 ? null : all[first]!.trim().match(/^(?:flowchart|graph)(?:\s+(LR|RL|TB|TD|BT))?\s*;?$/);
  if (!header) throw new Error('目前只支持 flowchart / graph 流程图。');
  const nodes = new Map<string, FlowNode>(), edges: FlowEdge[] = [], groups: FlowGroup[] = [], statements: Statement[] = [];
  // 打开中的子图及其块内提到的节点；Mermaid 让节点归属最先闭合的提及它的子图。
  const open: { group: FlowGroup; mentioned: Set<string> }[] = [];
  const assigned = new Set<string>();
  let current = '';
  const fail = (why: string): never => { throw new Error(`${why}：${current}`); };
  function endpoint(text: string, line: number, at: number): NodeToken {
    const rest = text.slice(at);
    const idMatch = rest.match(idPattern);
    if (!idMatch || idMatch[0] === 'end' || idMatch[0] === 'subgraph') fail('无法识别这一行的节点');
    const id = idMatch![0];
    let end = at + id.length, shape: Shape = 'rect', explicit: string | undefined, label: Span | undefined, quoted = true;
    if (text[end] === '@') fail('暂不支持 @{ } 形状写法');
    for (const [openText, closeText, kind] of shapes) {
      if (!text.startsWith(openText, end)) continue;
      const inner = end + openText.length;
      let close: number;
      if (text[inner] === '"') {
        const quote = text.indexOf('"', inner + 1);
        if (quote === -1 || !text.startsWith(closeText, quote + 1)) continue;
        explicit = text.slice(inner + 1, quote); label = { line, start: inner + 1, end: quote };
        close = quote + 1;
      } else {
        close = text.indexOf(closeText, inner);
        if (close === -1 || close === inner) continue;
        explicit = text.slice(inner, close);
        if (explicit.includes('"')) { explicit = undefined; continue; }
        label = { line, start: inner, end: close }; quoted = false;
      }
      end = close + closeText.length; shape = kind;
      break;
    }
    const cls = text.slice(end).match(/^:::[\w-]+/);
    if (cls) end += cls[0].length;
    const token: NodeToken = { id, line, start: at, end, quoted };
    if (label) token.label = label;
    if (explicit !== undefined || !nodes.has(id)) {
      const raw = explicit ?? id;
      nodes.set(id, {
        id, raw, label: displayText(raw), parent: nodes.get(id)?.parent, def: explicit !== undefined ? token : nodes.get(id)?.def,
        shape: explicit !== undefined ? shape : nodes.get(id)?.shape ?? 'rect',
      });
    }
    for (const frame of open) frame.mentioned.add(id);
    return token;
  }
  const skip = (text: string, at: number) => { while (at < text.length && /\s/.test(text[at]!)) at++; return at; };
  for (let index = first + 1; index < all.length; index++) {
    // 行尾分号只是语句结束符，不影响结构。
    const text = all[index]!.replace(/\s+$/, '').replace(/;$/, '');
    const line = text.trim();
    current = line;
    if (!line || line.startsWith('%%') || passthrough.test(line)) continue;
    if (/^subgraph\b/.test(line)) {
      const rest = line.slice('subgraph'.length).trim();
      if (!rest) fail('子图缺少名称');
      const sub = rest.match(/^([\p{L}\p{N}_]+)\s*(?:\["([^"\n]*)"\]|\[([^\]\n]+)\])?$/u);
      const quotedTitle = rest.match(/^"([^"\n]*)"$/);
      const id = sub ? sub[1]! : quotedTitle ? quotedTitle[1]! : rest;
      const title = sub ? sub[2] ?? sub[3] ?? id : id;
      if (groups.some(g => g.id === id)) fail(`子图 ${id} 重复定义`);
      const group: FlowGroup = { id, title: displayText(title), parent: open.at(-1)?.group.id, line: index, endLine: -1 };
      groups.push(group); open.push({ group, mentioned: new Set() });
      continue;
    }
    if (/^end$/.test(line)) {
      const frame = open.pop();
      if (!frame) fail('多余的 end，没有对应的 subgraph');
      frame!.group.endLine = index;
      for (const id of frame!.mentioned) if (!assigned.has(id)) { assigned.add(id); nodes.get(id)!.parent = frame!.group.id; }
      continue;
    }
    if (/^direction\s+(LR|RL|TB|TD|BT)$/.test(line)) {
      if (!open.length) fail('direction 只能写在子图内');
      continue; // 子图方向在有跨子图连线时会被 Mermaid 忽略；增强版统一使用整体方向。
    }
    if (/(^|\s)&(\s|$)/.test(line)) fail('暂不支持用 & 同时连接多个节点');
    const statement: Statement = { line: index, nodes: [], edges: [] };
    let node = endpoint(text, index, skip(text, 0));
    statement.nodes.push(node);
    let at = skip(text, node.end);
    while (at < text.length) {
      const rest = text.slice(at);
      let link: string, raw: string | undefined, length: number;
      const plain = rest.match(plainLink);
      if (plain) {
        link = plain[0];
        const pipe = rest.slice(link.length).match(/^\s*\|("([^"\n]*)"|[^|\n]*)\|/);
        raw = pipe ? pipe[2] ?? pipe[1] : undefined;
        length = link.length + (pipe ? pipe[0].length : rest.slice(link.length).match(/^\s*/)![0].length);
      } else {
        const withText = rest.match(textLink);
        if (!withText) fail('无法识别这一行的连线写法');
        const [all, back, opening, text, closing] = withText!;
        link = back! + (opening === '-.' ? '-' + closing! : closing!);
        raw = text!.replace(/^"(.*)"$/, '$1');
        length = all!.length + rest.slice(all!.length).match(/^\s*/)![0].length;
      }
      const token: EdgeToken = { line: index, start: at, end: at + length, edge: edges.length };
      const next = endpoint(text, index, skip(text, token.end));
      edges.push({ from: node.id, to: next.id, raw: raw ?? '', label: raw === undefined ? '' : displayText(raw), arrow: link.endsWith('>'), link, style: styleOf(link), token });
      statement.edges.push(token); statement.nodes.push(next);
      node = next; at = skip(text, next.end);
    }
    statements.push(statement);
  }
  current = '';
  if (open.length) throw new Error(`子图 ${open.at(-1)!.group.id} 缺少 end。`);
  for (const group of groups) if (nodes.has(group.id)) throw new Error(`暂不支持把子图 ${group.id} 当作节点或连线端点。`);
  if (!nodes.size) throw new Error('流程图中没有节点。');
  if (nodes.size > 300 || edges.length > 600) throw new Error('图太大：目前限制为 300 个节点、600 条连线。');
  return { direction: header[1] === 'TD' || !header[1] ? 'TB' : header[1], nodes: [...nodes.values()], edges, groups, statements };
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
