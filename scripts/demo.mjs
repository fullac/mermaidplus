// 用途：构建并在本机回环地址提供独立演示，不读取 Obsidian 知识库。
import { context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/demo', { recursive: true });
await copyFile('demo/index.html', 'dist/demo/index.html');
await copyFile('styles.css', 'dist/demo/styles.css');
const ctx = await context({
  entryPoints: ['demo/app.ts'], outdir: 'dist/demo', bundle: true, format: 'esm',
  splitting: true, loader: { '.md': 'text' }, target: 'es2022', logLevel: 'warning',
});
await ctx.rebuild();
if (process.argv.includes('--build')) await ctx.dispose();
else {
  const server = await ctx.serve({ host: '127.0.0.1', port: 4173, servedir: 'dist/demo' });
  console.log(`Mermaid Plus demo: http://127.0.0.1:${server.port}`);
}
