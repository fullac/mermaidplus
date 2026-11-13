// 用途：读取时序图的参与者、消息和注释，并标出不能安全增删或调序的语句行。
import { displayText, editText, type Span } from './flowchart';

export type { Span };
export { displayText, editText };

/** MVP 识别这些箭头；更长的写法必须排在前面。 */
export const ARROWS = ['-->>', '->>', '--)', '->x', '->', '-x', '-)'] as const;
export type Arrow = (typeof ARROWS)[number];

export interface Participant {
  id: string;
  /** 显示文字。没有 as 别名时等于 id。 */
  label: string;
  /** 别名原文；没有别名时等于 id。 */
  raw: string;
  /** 声明所在行。只在消息里出现、没有 participant/actor 行时为空。 */
  line?: number;
  quoted: boolean;
  /** participant 或 actor。隐式参与者为空。 */
  keyword?: 'participant' | 'actor';
  /** as 后面的原文范围，不含引号。 */
  alias?: Span;
}

export interface Message {
  index: number;
  from: string;
  to: string;
  arrow: Arrow;
  /** 显示文字。 */
  text: string;
  /** 冒号后的原文。 */
  raw: string;
  line: number;
  textSpan?: Span;
}

export interface Note {
  index: number;
  actors: string[];
  placement: 'over' | 'left of' | 'right of';
  text: string;
  raw: string;
  line: number;
  textSpan?: Span;
}

export interface SequenceDiagram {
  headerLine: number;
  participants: Participant[];
  messages: Message[];
  notes: Note[];
  /** 控制块、box、create 等暂不能安全改结构的行（从 0 计）。 */
  opaque: number[];
}

const idPattern = /^[\p{L}\p{N}_]+/u;
const barrier = /^(?:autonumber|activate|deactivate|accTitle|accDescr|title|links|link|properties|details)\b/i;
const opaqueLine = /^(?:loop|alt|opt|par(?:_over)?|rect|critical|break|else|and|option|box|create|destroy|end)\b/i;

/** 含控制块或未知语句时，只能改文字，不能增删或调序。 */
export function structuralBlock(diagram: SequenceDiagram): string | null {
  const line = diagram.opaque[0];
  if (line === undefined) return null;
  return `这张图含有暂不支持的语句（第 ${line + 1} 行），只能修改文字。`;
}

export function parseSequence(source: string): SequenceDiagram {
  const lines = source.split(/\r?\n/);
  const headerLine = findHeader(lines);
  const participants: Participant[] = [];
  const messages: Message[] = [];
  const notes: Note[] = [];
  const opaque: number[] = [];
  const byId = new Map<string, Participant>();

  const ensure = (id: string) => {
    if (byId.has(id)) return;
    const created: Participant = { id, label: id, raw: id, quoted: false };
    byId.set(id, created);
    participants.push(created);
  };

  for (let index = headerLine + 1; index < lines.length; index++) {
    const original = lines[index]!;
    const core = coreOf(original);
    if (!core.text) continue;
    if (core.text.startsWith('%%')) continue;
    const declared = parseDeclaration(core.text, index, core.start);
    if (declared) {
      const existing = byId.get(declared.id);
      if (existing) {
        existing.label = declared.label;
        existing.raw = declared.raw;
        existing.line = declared.line;
        existing.quoted = declared.quoted;
        existing.keyword = declared.keyword;
        existing.alias = declared.alias;
      } else {
        byId.set(declared.id, declared);
        participants.push(declared);
      }
      continue;
    }
    const message = parseMessage(core.text, index, core.start);
    if (message) {
      ensure(message.from);
      ensure(message.to);
      message.index = messages.length;
      messages.push(message);
      continue;
    }
    const note = parseNote(core.text, index, core.start);
    if (note) {
      for (const id of note.actors) ensure(id);
      note.index = notes.length;
      notes.push(note);
      continue;
    }
    if (barrier.test(core.text)) continue;
    if (opaqueLine.test(core.text) || core.text) opaque.push(index);
  }
  return { headerLine, participants, messages, notes, opaque };
}

function findHeader(lines: string[]): number {
  let index = 0;
  if (lines[0]?.trim() === '---') {
    index = 1;
    while (index < lines.length && lines[index]!.trim() !== '---') index++;
    if (index >= lines.length) throw new Error('图开头的 --- 配置缺少结束的 ---。');
    index++;
  }
  for (; index < lines.length; index++) {
    const text = lines[index]!.trim();
    if (!text || text.startsWith('%%')) continue;
    if (/^sequenceDiagram\b/.test(text)) return index;
    throw new Error('目前只支持 sequenceDiagram 时序图。');
  }
  throw new Error('目前只支持 sequenceDiagram 时序图。');
}

/** 去掉行首缩进和行尾空白、行尾 %% 注释，返回原文中的列范围。 */
function coreOf(original: string): { text: string; start: number } {
  const start = original.match(/^[ \t]*/)?.[0].length ?? 0;
  let end = original.length;
  while (end > start && /[ \t]/.test(original[end - 1]!)) end--;
  const body = original.slice(start, end);
  const comment = body.search(/[ \t]%%/);
  return { text: comment === -1 ? body : body.slice(0, comment).trimEnd(), start };
}

function parseDeclaration(text: string, line: number, start: number): Participant | null {
  const match = text.match(/^(participant|actor)\s+([\p{L}\p{N}_]+)(?:\s+as\s+([\s\S]+))?$/iu);
  if (!match) return null;
  const keyword = match[1]!.toLowerCase() as 'participant' | 'actor';
  const id = match[2]!;
  const aliasText = match[3];
  if (aliasText === undefined) return { id, label: id, raw: id, line, quoted: false, keyword };
  const alias = readAlias(aliasText);
  if (!alias) return null;
  const asAt = text.indexOf(aliasText);
  return {
    id, keyword, line, quoted: alias.quoted, raw: alias.raw, label: displayText(alias.raw),
    alias: { line, start: start + asAt + alias.offset, end: start + asAt + alias.offset + alias.raw.length },
  };
}

function readAlias(text: string): { raw: string; quoted: boolean; offset: number } | null {
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    if (end <= 1) return null;
    return { raw: text.slice(1, end), quoted: true, offset: 1 };
  }
  return { raw: text.trim(), quoted: false, offset: 0 };
}

function parseMessage(text: string, line: number, start: number): Message | null {
  const from = text.match(idPattern);
  if (!from) return null;
  let at = from[0].length;
  while (text[at] === ' ' || text[at] === '\t') at++;
  const arrow = ARROWS.find(item => text.startsWith(item, at));
  if (!arrow) return null;
  at += arrow.length;
  while (text[at] === ' ' || text[at] === '\t') at++;
  const to = text.slice(at).match(idPattern);
  if (!to) return null;
  at += to[0].length;
  while (text[at] === ' ' || text[at] === '\t') at++;
  if (text[at] !== ':') return null;
  at++;
  if (text[at] === ' ') at++;
  const raw = text.slice(at);
  return {
    index: 0, from: from[0], to: to[0], arrow, raw, text: displayText(raw), line,
    textSpan: { line, start: start + at, end: start + text.length },
  };
}

function parseNote(text: string, line: number, start: number): Note | null {
  const match = text.match(/^Note\s+(over|left of|right of)\s+([^:]+):\s?([\s\S]*)$/i);
  if (!match) return null;
  const placement = match[1]!.toLowerCase() as Note['placement'];
  const actors = match[2]!.split(',').map(item => item.trim()).filter(Boolean);
  if (!actors.length || actors.some(id => !idPattern.test(id))) return null;
  const raw = match[3] ?? '';
  const marker = text.lastIndexOf(raw);
  return {
    index: 0, actors, placement, raw, text: displayText(raw), line,
    textSpan: raw ? { line, start: start + marker, end: start + marker + raw.length } : { line, start: start + text.length, end: start + text.length },
  };
}
