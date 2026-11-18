import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {MemoryRecord, ProjectMemory} from './project-memory-reader.ts';

export type {MemoryRecord, ProjectMemory} from './project-memory-reader.ts';

const TOTAL_MS = 10000;
const TERM_MS = 200;
const REAP_MS = 1000;
const MAX_OUTPUT = 64 * 1024 * 1024;

/** 强杀后仍未确认回收；调用方接管 PID 的后续监护，exited 仅在实际退出并关闭管道后完成。 */
export class MemoryProcessCleanupError extends Error {
  /** 未确认退出的进程 ID，不代表该进程已经停止。 */
  readonly pid: number | undefined;
  /** 后续实际回收通知，可能永不完成，调用方不得无期限阻塞等待。 */
  readonly exited: Promise<void>;

  constructor(pid: number | undefined, exited: Promise<void>, cause: unknown) {
    super(`记忆读取进程无法确认回收，PID=${pid ?? '未知'}，调用方须接管监护`, {cause});
    this.name = 'MemoryProcessCleanupError';
    this.pid = pid;
    this.exited = exited;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

function isRecord(value: unknown): value is MemoryRecord {
  return isObject(value) && typeof value.id === 'string' && typeof value.kind === 'string' &&
    typeof value.status === 'string' && typeof value.verification === 'string' &&
    typeof value.body === 'string' && value.archive === 'not_loaded' && isObject(value.metadata);
}

function view(output: string): ProjectMemory {
  const data: unknown = JSON.parse(output);
  if (!isObject(data) || typeof data.projectId !== 'string' || !Array.isArray(data.records) || !data.records.every(isRecord)) {
    throw new Error('记忆子进程返回非法协议');
  }
  const projectId = data.projectId;
  const records = data.records;
  freeze(records);
  const byId = new Map(records.map(record => [record.id, record]));
  return Object.freeze({
    projectId,
    records,
    read: (id: string) => byId.get(id),
    search: (query: string) => {
      if (typeof query !== 'string' || !query.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(query)) throw new Error('非法搜索文本');
      const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
      return Object.freeze(terms.length ? records.filter(record => {
        const text = `${record.id}\n${JSON.stringify(record.metadata)}\n${record.body}`.toLowerCase();
        return terms.every(term => text.includes(term));
      }) : []);
    },
  });
}

/**
 * 仅在 Linux 子进程中读取已初始化项目的 schema 1 文本，返回冻结内存视图，不写缓存、不联网、不展开来源。
 * projectRoot 为无软链接的绝对路径，signal 由调用方持有，缺目录、格式错误、I/O 失败或取消均拒绝，空库合法。
 * 总读取截止为 10 秒，取消或失败先发送 TERM，200 毫秒后 KILL，再等最多 1 秒确认回收，正常返回前必须确认退出。
 * 若内核阻塞使强杀后仍不能确认回收，抛 MemoryProcessCleanupError，PID 后续监护归调用方，不声称工作已停止。
 * 子进程不继承环境变量和 Node 启动选项，结果只反映当前目录可见记录，不自动恢复任务或按 scope 注入。
 * 文件与目录变化检测不是跨文件事务快照，检测到变化整个加载失败，不自动重试。
 */
export async function loadProjectMemory(projectRoot: string, {signal}: {signal: AbortSignal}): Promise<ProjectMemory> {
  signal.throwIfAborted();
  if (process.platform !== 'linux') throw new Error('第一版只支持 Linux /proc/self/fd');
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/') || projectRoot.includes('\0')) throw new Error('projectRoot 必须是绝对路径');
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./project-memory-child.ts', import.meta.url)), projectRoot], {
      cwd: '/', env: {}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let notifyExit: () => void = () => {};
    const exited = new Promise<void>(resolveExit => { notifyExit = resolveExit; });
    let failure: unknown;
    let stopping = false;
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    let diagnostic = '';
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(termTimer);
      clearTimeout(reapTimer);
      signal.removeEventListener('abort', abort);
    };
    // 先推进停止状态，再发送信号；输出错误和取消共用同一截止及回收路径，不允许提前释放活进程所有权。
    const stop = (error: unknown) => {
      if (stopping || settled) return;
      stopping = true;
      failure = error;
      child.kill('SIGTERM');
      termTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reapTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(new MemoryProcessCleanupError(child.pid, exited, failure));
        }, REAP_MS);
      }, TERM_MS);
    };
    const abort = () => stop(signal.reason ?? new Error('记忆读取已取消'));
    const deadline = setTimeout(() => stop(new Error('记忆读取超过 10 秒总截止')), TOTAL_MS);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    child.on('error', stop);
    child.stdout.on('error', stop);
    child.stderr.on('error', stop);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopping) return;
      size += chunk.length;
      if (size > MAX_OUTPUT) stop(new Error('记忆子进程输出超过 64 MiB'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostic.length < 8192) diagnostic += chunk.toString('utf8');
    });
    child.once('close', (code, terminationSignal) => {
      notifyExit();
      if (settled) return;
      settled = true;
      cleanup();
      if (stopping) reject(failure);
      else if (code !== 0) reject(new Error(diagnostic || `记忆读取进程异常退出：${code}/${terminationSignal}`));
      else {
        try {
          resolve(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size)));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  signal.throwIfAborted();
  return view(output);
}
