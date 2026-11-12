// 用途：验证子图归属、<br/> 换行标签和非法子图写法，防止节点被分到错误的组或静默丢弃原文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFlowchart } from '../src/flowchart';

const sample = `flowchart TD
    MA["MA<br/>用户对话与任务委派"]
    OG["Orchestrator Gateway<br/>FA 请求入口与路由"]
    TG["Tool Gateway<br/>工具调用路由"]
    JAVA["Java MCP 服务<br/>执行具体工具"]

    subgraph POD_SIMPLE["一个 PoolHost Pod"]
        subgraph HOST_SIMPLE["PoolHost 主服务进程"]
            ENTRY_SIMPLE["请求接入与执行调度"]
            subgraph POOL_SIMPLE["AgentPool：管理 FA 执行对象"]
                FA1_SIMPLE["FA1 执行对象<br/>当前服务用户 A 的请求"]
                FA2_SIMPLE["FA2 执行对象<br/>当前服务用户 B 的请求"]
            end
            ENTRY_SIMPLE -->|借用| FA1_SIMPLE
            ENTRY_SIMPLE -->|借用| FA2_SIMPLE
        end
        JAIL1_SIMPLE["NsJail 子进程 A<br/>一次脚本执行，结束后清理"]
        JAIL2_SIMPLE["NsJail 子进程 B<br/>一次脚本执行，结束后清理"]
        FA1_SIMPLE -->|代码执行| JAIL1_SIMPLE
        FA2_SIMPLE -->|代码执行| JAIL2_SIMPLE
    end

    MA -->|调用 FA| OG
    OG -->|定向请求| ENTRY_SIMPLE
    FA1_SIMPLE -->|MCP 工具调用| TG
    FA2_SIMPLE -->|MCP 工具调用| TG
    TG --> JAVA`;

function node(id: string) {
  const found = parseFlowchart(sample).nodes.find(item => item.id === id);
  assert.ok(found, `缺少节点 ${id}`);
  return found;
}

test('用户原图的节点、连线、子图和换行标签', () => {
  const graph = parseFlowchart(sample);
  assert.equal(graph.nodes.length, 9);
  assert.equal(graph.edges.length, 9);
  assert.deepEqual(
    graph.groups.map(group => ({ id: group.id, parent: group.parent })),
    [
      { id: 'POD_SIMPLE', parent: undefined },
      { id: 'HOST_SIMPLE', parent: 'POD_SIMPLE' },
      { id: 'POOL_SIMPLE', parent: 'HOST_SIMPLE' },
    ],
  );
  assert.equal(graph.groups[0]?.title, '一个 PoolHost Pod');
  assert.equal(node('FA1_SIMPLE').parent, 'POOL_SIMPLE');
  assert.equal(node('FA2_SIMPLE').parent, 'POOL_SIMPLE');
  assert.equal(node('ENTRY_SIMPLE').parent, 'HOST_SIMPLE');
  assert.equal(node('JAIL1_SIMPLE').parent, 'POD_SIMPLE');
  assert.equal(node('JAIL2_SIMPLE').parent, 'POD_SIMPLE');
  for (const id of ['MA', 'OG', 'TG', 'JAVA']) assert.equal(node(id).parent, undefined);
  assert.equal(node('MA').label, 'MA\n用户对话与任务委派');
  assert.equal(node('MA').raw, 'MA<br/>用户对话与任务委派');
  assert.equal(graph.edges.filter(edge => edge.label === '借用').length, 2);
});

test('示例文件保留用户原图的缩进', () => {
  const markdown = readFileSync(new URL('../examples/subgraph.md', import.meta.url), 'utf8');
  const block = markdown.match(/```mermaid\n([\s\S]*?)```/);
  assert.equal(block?.[1]?.replace(/\n$/, ''), sample);
});

test('三种子图标题写法和子图内 direction 都能读入', () => {
  const graph = parseFlowchart(`flowchart LR
    subgraph OUTER["外层"]
      direction TB
      subgraph MID[中层]
        subgraph INNER
          A["甲"]
        end
      end
    end`);
  assert.deepEqual(
    graph.groups.map(group => ({ id: group.id, title: group.title, parent: group.parent })),
    [
      { id: 'OUTER', title: '外层', parent: undefined },
      { id: 'MID', title: '中层', parent: 'OUTER' },
      { id: 'INNER', title: 'INNER', parent: 'MID' },
    ],
  );
  assert.equal(graph.nodes[0]?.parent, 'INNER');
});

test('节点归属于最先闭合且提到过它的子图', () => {
  const graph = parseFlowchart(`flowchart TD
    subgraph OUTER
      subgraph INNER
        A["内"]
      end
      A --> B["外"]
    end
    C["顶"]`);
  assert.equal(graph.nodes.find(item => item.id === 'A')?.parent, 'INNER');
  assert.equal(graph.nodes.find(item => item.id === 'B')?.parent, 'OUTER');
  assert.equal(graph.nodes.find(item => item.id === 'C')?.parent, undefined);
});

test('行首缩进不影响解析', () => {
  const graph = parseFlowchart('flowchart TD\n    A["甲"] --> B["乙"]');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
});

test('<br> 的大小写和空格写法都变成换行，原文留在 raw', () => {
  const graph = parseFlowchart('flowchart TD\nA["上<BR>下"]\nB["左<Br />右"]');
  assert.equal(graph.nodes[0]?.label, '上\n下');
  assert.equal(graph.nodes[0]?.raw, '上<BR>下');
  assert.equal(graph.nodes[1]?.label, '左\n右');
  assert.equal(graph.nodes[1]?.raw, '左<Br />右');
});

test('无显式标签时 raw 等于 id', () => {
  const graph = parseFlowchart('flowchart TD\nA --> B');
  assert.equal(graph.nodes[0]?.raw, 'A');
  assert.equal(graph.nodes[0]?.label, 'A');
});

test('常见行内 HTML 标签只显示文字，原始写法保留在 raw', () => {
  const node = parseFlowchart('flowchart TD\nA["含<b>粗体</b>"]').nodes[0]!;
  assert.equal(node.label, '含粗体');
  assert.equal(node.raw, '含<b>粗体</b>');
});

test('未闭合的 subgraph 抛错', () => {
  assert.throws(() => parseFlowchart('flowchart TD\nsubgraph POD\nA["甲"]'));
});

test('多余的 end 抛错', () => {
  assert.throws(() => parseFlowchart('flowchart TD\nA["甲"]\nend'));
});

test('连线端点使用子图 id 抛错', () => {
  assert.throws(() => parseFlowchart('flowchart TD\nsubgraph POD\nA["甲"]\nend\nA --> POD'));
});

test('子图 id 与节点 id 重复抛错', () => {
  assert.throws(() => parseFlowchart('flowchart TD\nA["甲"]\nsubgraph A\nB["乙"]\nend'));
});
