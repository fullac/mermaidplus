// 用途：把时序图编辑动作写成对源码的最小改动，只替换相关行并保留其余缩进、注释和行尾。
import type { EditResult } from './edit';
import { displayText, parseSequence, structuralBlock, type Note, type Participant, type SequenceDiagram } from './sequence';

export type { EditResult };

function split(source: string) {
  return { lines: source.split(/\r?\n/), eol: source.includes('\r\n') ? '\r\n' : '\n' };
}

/** 时序图文字保持纯文本：换行写成 <br/>，不套用流程图的 Markdown 反引号标签。 */
function toSequenceRaw(text: string, kind: 'alias' | 'body'): string {
  const value = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).join('\n').trim();
  if (!value) throw new Error('文字不能为空。');
  if (kind === 'alias' && value.includes('"')) throw new Error('文字不能包含英文双引号 "，可以改用中文引号。');
  return value.replace(/\n/g, '<br/>');
}

function formatAlias(raw: string, quoted: boolean): string {
  return quoted || /[\s:#<>]/.test(raw) || raw.includes('<br') ? `"${raw}"` : raw;
}

function indentOf(lines: string[], around: number): string {
  for (let i = around; i < lines.length; i++) if (lines[i]!.trim()) return lines[i]!.match(/^[ \t]*/)?.[0] ?? '';
  for (let i = around - 1; i >= 0; i--) if (lines[i]!.trim()) return lines[i]!.match(/^[ \t]*/)?.[0] ?? '';
  return '    ';
}

function requireDiagram(source: string): SequenceDiagram {
  return parseSequence(source);
}

function requireMutable(diagram: SequenceDiagram) {
  const reason = structuralBlock(diagram);
  if (reason) throw new Error(reason);
}

function finish(next: string, select: EditResult['select'], check: (diagram: SequenceDiagram) => void): EditResult {
  let diagram: SequenceDiagram;
  try { diagram = parseSequence(next); }
  catch { throw new Error('修改后的时序图无法解析，已取消。'); }
  check(diagram);
  return { source: next, select };
}

function replaceSpan(lines: string[], line: number, start: number, end: number, raw: string) {
  const current = lines[line];
  if (current === undefined) throw new Error('找不到要修改的那一行。');
  lines[line] = current.slice(0, start) + raw + current.slice(end);
}

/** 修改参与者显示名。没有声明行时，在 sequenceDiagram 的下一行补上 participant。 */
export function setParticipantLabel(source: string, id: string, text: string): EditResult {
  const diagram = requireDiagram(source);
  const participant = diagram.participants.find(item => item.id === id);
  if (!participant) throw new Error(`找不到参与者 ${id}。`);
  const raw = toSequenceRaw(text, 'alias');
  if (participant.line === undefined && displayText(raw) === participant.label) return { source, select: { node: id } };
  const { lines, eol } = split(source);
  if (participant.line === undefined) {
    const indent = indentOf(lines, diagram.headerLine + 1);
    lines.splice(diagram.headerLine + 1, 0, `${indent}participant ${id} as ${formatAlias(raw, false)}`);
  } else if (participant.alias) {
    const quoted = participant.quoted || /[\s:#<>]/.test(raw) || raw.includes('<br');
    const start = participant.quoted ? participant.alias.start - 1 : participant.alias.start;
    const end = participant.quoted ? participant.alias.end + 1 : participant.alias.end;
    replaceSpan(lines, participant.line, start, end, formatAlias(raw, quoted));
  } else if (displayText(raw) !== id) {
    const current = lines[participant.line]!;
    const tail = current.match(/[ \t]*%%.*$/)?.[0] ?? '';
    const head = tail ? current.slice(0, current.length - tail.length).trimEnd() : current.trimEnd();
    lines[participant.line] = `${head} as ${formatAlias(raw, false)}${tail}`;
  } else {
    return { source, select: { node: id } };
  }
  return finish(lines.join(eol), { node: id }, next => {
    const found = next.participants.find(item => item.id === id);
    if (!found || found.label !== displayText(raw)) throw new Error('修改后的参与者对不上，已取消。');
  });
}

/** 修改消息文字。空文字保留冒号，写成 A->>B:。 */
export function setMessageText(source: string, index: number, text: string): EditResult {
  const diagram = requireDiagram(source);
  const message = diagram.messages[index];
  if (!message?.textSpan) throw new Error('找不到这条消息。');
  const raw = text.trim() ? toSequenceRaw(text, 'body') : '';
  const { lines, eol } = split(source);
  const current = lines[message.line]!;
  let start = message.textSpan.start;
  let end = message.textSpan.end;
  if (!raw && start > 0 && current[start - 1] === ' ') start--;
  replaceSpan(lines, message.line, start, end, raw);
  return finish(lines.join(eol), { edge: index }, next => {
    const found = next.messages[index];
    if (!found || found.from !== message.from || found.to !== message.to || found.raw !== raw) throw new Error('修改后的消息对不上，已取消。');
  });
}

/** 修改注释文字。 */
export function setNoteText(source: string, index: number, text: string): EditResult {
  const diagram = requireDiagram(source);
  const note = diagram.notes[index];
  if (!note?.textSpan) throw new Error('找不到这条注释。');
  const raw = toSequenceRaw(text, 'body');
  const { lines, eol } = split(source);
  replaceSpan(lines, note.line, note.textSpan.start, note.textSpan.end, raw);
  return finish(lines.join(eol), {}, next => {
    const found = next.notes[index];
    if (!found || found.raw !== raw) throw new Error('修改后的注释对不上，已取消。');
  });
}

function nextParticipantId(diagram: SequenceDiagram): string {
  const used = new Set(diagram.participants.map(item => item.id));
  for (let i = 1; ; i++) if (!used.has(`P${i}`)) return `P${i}`;
}

/** 新增参与者，插在最后一条 participant/actor 声明之后。 */
export function addParticipant(source: string, text = '新参与者'): EditResult {
  const diagram = requireDiagram(source);
  requireMutable(diagram);
  const raw = toSequenceRaw(text, 'alias');
  const id = nextParticipantId(diagram);
  const { lines, eol } = split(source);
  const declared = diagram.participants.filter(item => item.line !== undefined);
  const at = (declared.length ? Math.max(...declared.map(item => item.line!)) : diagram.headerLine) + 1;
  lines.splice(at, 0, `${indentOf(lines, at)}${idLine(id, raw)}`);
  return finish(lines.join(eol), { node: id }, next => {
    if (!next.participants.some(item => item.id === id && item.label === displayText(raw))) throw new Error('新增的参与者没有写上，已取消。');
  });
}

function idLine(id: string, raw: string): string {
  return displayText(raw) === id ? `participant ${id}` : `participant ${id} as ${formatAlias(raw, false)}`;
}

/** 删除没有被消息或注释使用的参与者声明。 */
export function deleteParticipant(source: string, id: string): EditResult {
  const diagram = requireDiagram(source);
  requireMutable(diagram);
  const participant = diagram.participants.find(item => item.id === id);
  if (!participant) throw new Error(`找不到参与者 ${id}。`);
  if (participant.line === undefined) throw new Error(`参与者 ${id} 没有单独的声明行。`);
  const used = [
    ...diagram.messages.filter(item => item.from === id || item.to === id).map(item => item.text || `${item.from}→${item.to}`),
    ...diagram.notes.filter(item => item.actors.includes(id)).map(item => item.text || '注释'),
  ];
  if (used.length) throw new Error(`参与者 ${id} 还被使用：${used.slice(0, 3).join('、')}。`);
  const { lines, eol } = split(source);
  lines.splice(participant.line, 1);
  return finish(lines.join(eol), {}, next => {
    if (next.participants.some(item => item.id === id)) throw new Error('参与者没有删掉，已取消。');
  });
}

/**
 * 新增消息。afterIndex 是选中消息的序号，不传则追加到最后一条消息之后。
 * 选中参与者时从该参与者指向另一端；否则从最后一名参与者指向第一名。
 */
export function addMessage(source: string, afterIndex?: number, fromId?: string): EditResult {
  const diagram = requireDiagram(source);
  requireMutable(diagram);
  if (!diagram.participants.length) throw new Error('至少需要一个参与者。');
  if (fromId && !diagram.participants.some(item => item.id === fromId)) throw new Error(`找不到参与者 ${fromId}。`);
  const from = diagram.participants.find(item => item.id === fromId) ?? diagram.participants[diagram.participants.length - 1]!;
  const to = diagram.participants.find(item => item.id !== from.id) ?? from;
  const { lines, eol } = split(source);
  const at = insertionLine(diagram, lines, afterIndex);
  lines.splice(at, 0, `${indentOf(lines, at)}${from.id}->>${to.id}: 新消息`);
  const index = afterIndex === undefined ? diagram.messages.length : afterIndex + 1;
  return finish(lines.join(eol), { edge: index }, next => {
    const found = next.messages[index];
    if (!found || found.raw !== '新消息' || found.from !== from.id || found.to !== to.id) throw new Error('新增的消息没有写上，已取消。');
  });
}

function insertionLine(diagram: SequenceDiagram, lines: string[], afterIndex?: number): number {
  if (afterIndex !== undefined) {
    const message = diagram.messages[afterIndex];
    if (!message) throw new Error('找不到这条消息。');
    return message.line + 1;
  }
  const lastMessage = diagram.messages[diagram.messages.length - 1];
  if (lastMessage) return lastMessage.line + 1;
  const declared = diagram.participants.filter((item): item is Participant & { line: number } => item.line !== undefined);
  return (declared.length ? Math.max(...declared.map(item => item.line)) : diagram.headerLine) + 1;
}

/** 删除一条消息，不连带删除因此无人使用的参与者。 */
export function deleteMessage(source: string, index: number): EditResult {
  const diagram = requireDiagram(source);
  requireMutable(diagram);
  const message = diagram.messages[index];
  if (!message) throw new Error('找不到这条消息。');
  const { lines, eol } = split(source);
  lines.splice(message.line, 1);
  const nextIndex = diagram.messages.length > 1 ? Math.min(index, diagram.messages.length - 2) : undefined;
  return finish(lines.join(eol), nextIndex === undefined ? {} : { edge: nextIndex }, next => {
    if (next.messages.length !== diagram.messages.length - 1) throw new Error('消息没有删掉，已取消。');
  });
}

/** 与上一条或下一条紧邻的消息交换。中间有注释、activate、空行或其他语句时拒绝。 */
export function moveMessage(source: string, index: number, direction: -1 | 1): EditResult {
  const diagram = requireDiagram(source);
  requireMutable(diagram);
  const current = diagram.messages[index];
  const neighbor = diagram.messages[index + direction];
  if (!current || !neighbor) throw new Error(direction < 0 ? '已经是第一条消息。' : '已经是最后一条消息。');
  if (Math.abs(current.line - neighbor.line) !== 1) throw new Error('两条消息之间还有其他内容，不能调整顺序。');
  const { lines, eol } = split(source);
  const saved = lines[current.line]!;
  lines[current.line] = lines[neighbor.line]!;
  lines[neighbor.line] = saved;
  return finish(lines.join(eol), { edge: index + direction }, next => {
    const found = next.messages[index + direction];
    if (!found || found.from !== current.from || found.to !== current.to || found.raw !== current.raw) throw new Error('消息顺序没有换过来，已取消。');
  });
}

/** 交换两条显式声明的先后。存在只在消息里出现的参与者时拒绝，避免打乱 Mermaid 的出现顺序。 */
export function moveParticipant(source: string, id: string, direction: -1 | 1): EditResult {
  const diagram = requireDiagram(source);
  requireMutable(diagram);
  if (diagram.participants.some(item => item.line === undefined)) throw new Error('有参与者只写在消息里，调整声明顺序会排错。');
  const declared = [...diagram.participants].filter((item): item is Participant & { line: number } => item.line !== undefined).sort((a, b) => a.line - b.line);
  const index = declared.findIndex(item => item.id === id);
  const neighbor = declared[index + direction];
  const current = declared[index];
  if (!current || !neighbor) throw new Error(direction < 0 ? '已经在最左边。' : '已经在最右边。');
  const { lines, eol } = split(source);
  const saved = lines[current.line]!;
  lines[current.line] = lines[neighbor.line]!;
  lines[neighbor.line] = saved;
  return finish(lines.join(eol), { node: id }, next => {
    const order = next.participants.filter(item => item.line !== undefined).sort((a, b) => a.line! - b.line!).map(item => item.id);
    const at = order.indexOf(id);
    if (order[at + direction] !== neighbor.id && order[at - direction] !== current.id) {
      if (order[at] !== id || order[at - direction] !== neighbor.id) throw new Error('参与者顺序没有换过来，已取消。');
    }
  });
}

/** 注释仍被消息以外的语句引用时，供编辑器判断按钮状态。 */
export function noteUses(diagram: SequenceDiagram, id: string): Note[] {
  return diagram.notes.filter(item => item.actors.includes(id));
}
