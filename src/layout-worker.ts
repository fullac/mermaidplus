// 用途：将布局计算移到独立线程，支持取消与超时，避免复杂图阻塞编辑界面；环境不允许启动线程时（如部分 Obsidian 环境）改在当前页面计算。
import ELK from 'elkjs/lib/elk-api.js';
import workerSource from 'elkjs/lib/elk-worker.min.js' with { type: 'text' };
import { layoutFlowchart, type Size, type LayoutSettings, type DiagramLayout } from './layout';
import type { Flowchart } from './flowchart';

interface WorkerLike { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null; terminate?(): void }

/** 线程启动失败后不再重复尝试，直接在当前页面计算。 */
let workerBroken = false;
let InlineWorker: (new () => WorkerLike) | undefined;

/** 在当前页面运行 elkjs 自带的同步版布局引擎（elkjs 在 Node 等无线程环境下也是这样用的）。 */
function inlineWorker(): WorkerLike {
  if (!InlineWorker) {
    const module = { exports: {} as { Worker?: new () => WorkerLike } };
    new Function('module', 'exports', workerSource)(module, module.exports);
    if (!module.exports.Worker) throw new Error('无法加载布局引擎。');
    InlineWorker = module.exports.Worker;
  }
  return new InlineWorker();
}

export async function layoutInWorker(chart: Flowchart, sizes: Map<string, Size>, labels: Size[], settings: LayoutSettings, available: Size, signal?: AbortSignal): Promise<DiagramLayout> {
  if (!workerBroken) {
    try {
      return await layoutWith('thread', chart, sizes, labels, settings, available, signal);
    } catch (error) {
      if (!(error instanceof WorkerStartError)) throw error;
      workerBroken = true;
      console.warn('[Mermaid Plus] 布局线程无法启动，改为在当前页面计算。', error.cause);
    }
  }
  return layoutWith('inline', chart, sizes, labels, settings, available, signal);
}

class WorkerStartError extends Error {}

async function layoutWith(mode: 'thread' | 'inline', chart: Flowchart, sizes: Map<string, Size>, labels: Size[], settings: LayoutSettings, available: Size, signal?: AbortSignal): Promise<DiagramLayout> {
  if (signal?.aborted) throw new Error('布局已取消。');
  let url: string | undefined;
  let worker: WorkerLike | undefined;
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (mode === 'thread') {
      url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      try { worker = new Worker(url) as unknown as WorkerLike; } catch (error) { throw new WorkerStartError('无法启动布局线程。', { cause: error }); }
    } else worker = inlineWorker();
    const engine = new ELK({ algorithms: ['layered'], workerFactory: () => worker as unknown as Worker });
    return await new Promise<DiagramLayout>((resolve, reject) => {
      cancel = () => reject(new Error('布局已取消。'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (mode === 'thread') {
        (worker as unknown as Worker).addEventListener('error', event => {
          event.preventDefault();
          reject(new WorkerStartError('无法启动布局线程。', { cause: event.message || event }));
        }, { once: true });
      }
      timer = setTimeout(() => reject(new Error('自动整理超过 8 秒，已经停了。可以固定一个方向，或者把图拆小。')), 8000);
      layoutFlowchart(chart, sizes, labels, settings, available, graph => engine.layout(graph)).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
    worker?.terminate?.();
    if (url) URL.revokeObjectURL(url);
  }
}
