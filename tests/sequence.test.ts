// 用途：验证时序图解析和写回只改目标行，并保留缩进、注释、行尾和控制块原文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { changedLines } from '../src/edit';
import { parseSequence, structuralBlock } from '../src/sequence';
import {
  addMessage, addParticipant, deleteMessage, deleteParticipant, moveMessage, moveParticipant,
  setMessageText, setNoteText, setParticipantLabel,
} from '../src/sequenceEdit';

const sample = `sequenceDiagram
    participant 用户 as 访客
    participant API
    用户->>API: 查询
    API-->>用户: 返回结果
    Note over 用户,API: 同步完成
`;

const diffCount = (a: string, b: string) => { const c = changedLines(a, b); return { removed: c.to - c.from, added: c.lines.length }; };

test('解析显式参与者、隐式参与者、消息和注释', () => {
  const chart = parseSequence(`sequenceDiagram
    Alice->>Bob: 你好
    participant Bob as "鲍勃"
    Note right of Alice: 旁白
`);
  assert.equal(chart.headerLine, 0);
  assert.deepEqual(chart.participants.map(item => [item.id, item.label, item.line, item.quoted]), [
    ['Alice', 'Alice', undefined, false],
    ['Bob', '鲍勃', 2, true],
  ]);
  assert.equal(chart.messages[0]!.arrow, '->>');
  assert.equal(chart.messages[0]!.text, '你好');
  assert.equal(chart.notes[0]!.placement, 'right of');
  assert.deepEqual(chart.notes[0]!.actors, ['Alice']);
  assert.equal(structuralBlock(chart), null);
});

test('识别四种箭头、自消息和 front matter', () => {
  const chart = parseSequence(`---
title: 示例
---
%% 开头注释

sequenceDiagram
    A->B: 实线
    B-->>A: 虚线
    A--)B: 开放
    A->>A: 自己
`);
  assert.deepEqual(chart.messages.map(item => item.arrow), ['->', '-->>', '--)', '->>']);
  assert.equal(chart.messages[3]!.from, 'A');
  assert.equal(chart.messages[3]!.to, 'A');
  assert.equal(chart.headerLine, 5);
});

test('控制块和未知语句标成 opaque，activate 不计入', () => {
  const chart = parseSequence(`sequenceDiagram
    autonumber
    Alice->>Bob: 请求
    activate Bob
    alt 成功
        Bob-->>Alice: 好
    else 失败
        Bob-->>Alice: 不好
    end
    deactivate Bob
`);
  assert.deepEqual(chart.opaque, [4, 6, 8]);
  assert.match(structuralBlock(chart)!, /第 5 行/);
  assert.equal(chart.messages.length, 3);
});

test('改参与者显示名只替换 as 后面的文字', () => {
  const next = setParticipantLabel(sample, '用户', '登录用户').source;
  assert.deepEqual(diffCount(sample, next), { removed: 1, added: 1 });
  assert.match(next, /^ {4}participant 用户 as 登录用户$/m);
  assert.match(next, /用户->>API: 查询/);
  assert.equal(parseSequence(next).participants.find(item => item.id === '用户')!.label, '登录用户');
});

test('隐式参与者改显示名时在头后面插入声明', () => {
  const source = 'sequenceDiagram\n    Alice->>Bob: 你好\n';
  const next = setParticipantLabel(source, 'Alice', '爱丽丝').source;
  assert.equal(next, 'sequenceDiagram\n    participant Alice as 爱丽丝\n    Alice->>Bob: 你好\n');
  assert.equal(parseSequence(next).participants[0]!.line, 1);
});

test('别名里的英文双引号被拒绝，换行写成 <br/>', () => {
  assert.throws(() => setParticipantLabel(sample, '用户', '含"引号'), /双引号/);
  const next = setParticipantLabel(sample, 'API', '接口\n网关').source;
  assert.match(next, /^ {4}participant API as "接口<br\/>网关"$/m);
  assert.equal(parseSequence(next).participants.find(item => item.id === 'API')!.label, '接口\n网关');
});

test('改消息文字只替换冒号之后，空文字保留冒号', () => {
  const next = setMessageText(sample, 0, '查询订单').source;
  assert.deepEqual(diffCount(sample, next), { removed: 1, added: 1 });
  assert.match(next, /^ {4}用户->>API: 查询订单$/m);
  assert.match(next, /API-->>用户: 返回结果/);
  const cleared = setMessageText(sample, 1, '  ').source;
  assert.match(cleared, /^ {4}API-->>用户:$/m);
  assert.equal(parseSequence(cleared).messages[1]!.raw, '');
  assert.deepEqual(setMessageText(sample, 0, '第一行\n第二行').select, { edge: 0 });
});

test('改注释文字只替换冒号之后', () => {
  const next = setNoteText(sample, 0, '已经同步').source;
  assert.match(next, /^ {4}Note over 用户,API: 已经同步$/m);
  assert.deepEqual(diffCount(sample, next), { removed: 1, added: 1 });
  assert.throws(() => setNoteText(sample, 0, '  '), /文字不能为空/);
});

test('新增和删除参与者', () => {
  const added = addParticipant(sample);
  assert.equal(added.select?.node, 'P1');
  assert.match(added.source, /participant API\n {4}participant P1 as 新参与者\n {4}用户->>API/);
  const removed = deleteParticipant(added.source, 'P1');
  assert.equal(removed.source, sample);
  assert.throws(() => deleteParticipant(sample, '用户'), /还被使用/);
  assert.throws(() => deleteParticipant('sequenceDiagram\n    A->>B: 你好\n', 'A'), /没有单独的声明行/);
});

test('新增和删除消息，不连带删除参与者', () => {
  const added = addMessage(sample, 0, '用户');
  assert.equal(added.select?.edge, 1);
  assert.match(added.source, /用户->>API: 查询\n {4}用户->>API: 新消息\n {4}API-->>用户/);
  const removed = deleteMessage(added.source, 1);
  assert.equal(removed.source, sample);
  assert.equal(deleteMessage(sample, 1).select?.edge, 0);
  const only = 'sequenceDiagram\n    participant A\n    A->>A: 自己\n';
  assert.match(addMessage(only).source, /A->>A: 新消息/);
});

test('相邻消息可以交换，中间夹着其他内容时拒绝', () => {
  const moved = moveMessage(sample, 0, 1);
  assert.match(moved.source, /API-->>用户: 返回结果\n {4}用户->>API: 查询/);
  assert.equal(moved.select?.edge, 1);
  const blocked = `sequenceDiagram
    A->>B: 一
    activate B
    B-->>A: 二
`;
  assert.throws(() => moveMessage(blocked, 0, 1), /其他内容/);
  assert.throws(() => moveMessage(sample, 0, -1), /第一条/);
});

test('显式参与者左右交换；存在隐式参与者时拒绝', () => {
  const moved = moveParticipant(sample, '用户', 1);
  assert.match(moved.source, /participant API\n {4}participant 用户 as 访客/);
  assert.equal(moved.select?.node, '用户');
  assert.throws(() => moveParticipant('sequenceDiagram\n    participant A\n    A->>B: 你好\n', 'A', 1), /只写在消息里/);
  assert.throws(() => moveParticipant(sample, 'API', 1), /最右边/);
});

test('含控制块时仍可改文字，增删和调序被拒绝，原文保留', () => {
  const source = `sequenceDiagram
    participant A
    participant B
    A->>B: 请求
    loop 重试
        B-->>A: 再来
    end
`;
  const next = setMessageText(source, 0, '新请求').source;
  assert.match(next, /loop 重试/);
  assert.match(next, /A->>B: 新请求/);
  assert.throws(() => addParticipant(source), /只能修改文字/);
  assert.throws(() => addMessage(source), /只能修改文字/);
  assert.throws(() => deleteMessage(source, 0), /只能修改文字/);
  assert.throws(() => moveMessage(source, 0, 1), /只能修改文字/);
  assert.throws(() => deleteParticipant(source, 'A'), /只能修改文字/);
});

test('保留 CRLF 和行尾注释', () => {
  const source = 'sequenceDiagram\r\n    participant A as 甲 %% 保留\r\n    A->>A: 自己\r\n';
  const next = setParticipantLabel(source, 'A', '乙').source;
  assert.equal(next, 'sequenceDiagram\r\n    participant A as 乙 %% 保留\r\n    A->>A: 自己\r\n');
});
