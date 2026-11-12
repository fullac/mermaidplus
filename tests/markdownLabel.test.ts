// 用途：验证选中文字加 / 去粗体斜体的规则，以及改字时写成 Mermaid 原生 Markdown 标签。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMarkdownMarks, toggleMark } from '../src/markdownLabel';
import { setEdgeLabel, setNodeLabel, toRawLabel } from '../src/edit';
import { editText, parseFlowchart } from '../src/flowchart';

const sel = (value: string, part: string) => [value.indexOf(part), value.indexOf(part) + part.length] as const;

test('加粗、斜体，选区跟着文字走，两端空白不包进去', () => {
  assert.deepEqual(toggleMark('读取 配置', 3, 5, 'bold'), { value: '读取 **配置**', start: 5, end: 7 });
  assert.deepEqual(toggleMark('读取 配置', 2, 5, 'italic'), { value: '读取 *配置*', start: 4, end: 6 });
  assert.equal(toggleMark('a  ', 1, 3, 'bold').value, 'a  ');
});

test('再按一次去掉：标记在选区外或选区内都可以', () => {
  const v = '读取 **配置**';
  assert.equal(toggleMark(v, ...sel(v, '配置'), 'bold').value, '读取 配置');
  assert.equal(toggleMark(v, ...sel(v, '**配置**'), 'bold').value, '读取 配置');
  const i = 'a *b* c';
  assert.equal(toggleMark(i, ...sel(i, 'b'), 'italic').value, 'a b c');
});

test('粗体和斜体可叠加、可分别去掉', () => {
  const bold = '**x**';
  const both = toggleMark(bold, 2, 3, 'italic');
  assert.equal(both.value, '***x***');
  assert.equal(toggleMark(both.value, both.start, both.end, 'bold').value, '*x*');
  assert.equal(toggleMark(both.value, both.start, both.end, 'italic').value, '**x**');
  // 粗体文字里按斜体是加，不是去。
  assert.equal(toggleMark(bold, 2, 3, 'italic').value, '***x***');
});

test('只认成对星号', () => {
  assert.equal(hasMarkdownMarks('**粗**'), true);
  assert.equal(hasMarkdownMarks('a *斜* b'), true);
  assert.equal(hasMarkdownMarks('a * b * c'), false);
  assert.equal(hasMarkdownMarks('2*3=6'), false);
  assert.equal(hasMarkdownMarks('user_id_name'), false);
});

test('带标记的文字写成 Markdown 标签，普通文字不变', () => {
  assert.equal(toRawLabel('**粗**\n第二行', 'node'), '`**粗**<br/>第二行`');
  assert.equal(toRawLabel('*斜*', 'edge'), '"`*斜*`"');
  assert.equal(toRawLabel('普通', 'node'), '普通');
  assert.throws(() => toRawLabel('**a** `b`', 'node'));
});

test('节点、连线改字后写回 Markdown，编辑框里不显示反引号', () => {
  const src = 'flowchart TD\n  A[开始] --> B\n  B -->|是| C\n';
  const node = setNodeLabel(src, 'A', '**开始**').source;
  assert.equal(node.split('\n')[1], '  A["`**开始**`"] --> B');
  const chart = parseFlowchart(node);
  assert.equal(chart.nodes[0]!.label, '开始');
  assert.equal(editText(chart.nodes[0]!.raw), '**开始**');
  const edge = setEdgeLabel(src, 1, '*是*').source;
  assert.equal(edge.split('\n')[2], '  B -->|"`*是*`"| C');
  assert.equal(editText(parseFlowchart(edge).edges[1]!.raw), '*是*');
});

test('原来是 Markdown 标签的，去掉格式后仍保持 Markdown 写法', () => {
  const src = 'flowchart TD\n  A["`**开始**`"]\n';
  assert.equal(setNodeLabel(src, 'A', '开始').source, 'flowchart TD\n  A["`开始`"]\n');
});
