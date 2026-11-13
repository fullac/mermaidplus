// 用途：构建插件和演示时裁掉用不到的 Mermaid 图类型、排版方式，以及流程图/时序图用不到的可选功能。
/**
 * 插件自带的 Mermaid 只画流程图和时序图（其他图类型交给 Obsidian 自己的 Mermaid），排版只用 ELK 和 dagre。
 * Mermaid 按图类型、排版方式动态加载代码，打成单文件时会全部内联进来（连同 cytoscape 等依赖）。
 * 这里把用不到的图类型和排版方式换成一个直接报错的空模块，安装包能小一大半。
 */
// 流程图形状用到的图标和尺寸调试模块很小，一并保留。
const KEEP = /\/(flowDiagram|sequenceDiagram|elk|dagre|bpmnIcons|sizeCapture)-\w+\.mjs$/;
/**
 * KaTeX 只用于标签里的数学公式（$$…$$），Mermaid 在渲染时才动态加载它，本身就有 550 KB 源码（压缩后 260 KB）。
 * 这里换成一个不排版、也不报错的空实现：公式按原文显示，整张图照常渲染。
 */
const KATEX_STUB = [
  'const text = value => String(value ?? "");',
  'export default { renderToString: text, render: (value, element) => { if (element) element.textContent = text(value); } };',
].join('\n');

export const onlyUsedMermaid = {
  name: 'only-used-mermaid',
  setup(build) {
    build.onResolve({ filter: /\.mjs$/ }, args => {
      if (args.kind !== 'dynamic-import' || !/node_modules\/mermaid\/dist\//.test(args.importer) || !/^\.{1,2}\//.test(args.path) || KEEP.test(args.path)) return undefined;
      return { path: args.path, namespace: 'unused-mermaid' };
    });
    build.onLoad({ filter: /.*/, namespace: 'unused-mermaid' }, () => ({ contents: "throw new Error('Mermaid Plus 只渲染流程图和时序图。');", loader: 'js' }));
    build.onResolve({ filter: /^katex$/ }, args => {
      if (!/node_modules\/mermaid\/dist\//.test(args.importer)) return undefined;
      return { path: 'katex', namespace: 'unused-katex' };
    });
    build.onLoad({ filter: /.*/, namespace: 'unused-katex' }, () => ({ contents: KATEX_STUB, loader: 'js' }));
  },
};
