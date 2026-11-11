// 用途：将布局计算移到独立线程，支持取消与超时，避免复杂图阻塞编辑界面。
import ELK from 'elkjs/lib/elk-api.js';
import workerSource from 'elkjs/lib/elk-worker.min.js' with { type: 'text' };
import { layoutFlowchart, type Size, type LayoutSettings, type DiagramLayout } from './layout';
import type { Flowchart } from './flowchart';

export async function layoutInWorker(chart: Flowchart, sizes: Map<string, Size>, labels: Size[], settings: LayoutSettings, available: Size, signal?: AbortSignal): Promise<DiagramLayout> {
  if (signal?.aborted) throw new Error('布局已取消。');
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  let worker: Worker | undefined;
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(url);
    const engine = new ELK({ algorithms: ['layered'], workerFactory: () => worker! });
    return await new Promise<DiagramLayout>((resolve, reject) => {
      cancel = () => reject(new Error('布局已取消。'));
      signal?.addEventListener('abort', cancel, { once: true });
      worker!.addEventListener('error', () => reject(new Error('无法启动布局线程，请检查当前环境的 Worker 支持。')), { once: true });
      timer = setTimeout(() => reject(new Error('自动整理超过 8 秒，已停止计算；请尝试单一方向或拆分流程图。')), 8000);
      layoutFlowchart(chart, sizes, labels, settings, available, graph => engine.layout(graph)).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
    worker?.terminate();
    URL.revokeObjectURL(url);
  }
}
