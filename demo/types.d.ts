// 用途：声明由构建工具作为文本载入的测试文档。
declare module '*.md' { const text: string; export default text; }
