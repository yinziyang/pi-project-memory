import {spawn} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {resolve, sep} from 'node:path';

const retainedDirectories = new Set<string>();

/** 只清理已确认不再由未回收测试进程占用的 fixture，否则保留目录供后续监护。 */
export async function removeFixture(root: string): Promise<void> {
  const absolute = resolve(root);
  if ([...retainedDirectories].some(cwd => cwd === absolute || cwd.startsWith(`${absolute}${sep}`))) {
    throw new Error(`测试进程组尚未确认回收，保留 fixture：${absolute}`);
  }
  await rm(root, {recursive: true, force: true});
}

function gone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    throw error;
  }
}

/** 测试专用命令边界，仅允许 Git/mkfifo，timeoutMs 为毫秒且默认 5000，失败后最多再用 1200 毫秒回收整个独立进程组。 */
export async function runFixtureCommand(cwd: string, command: 'git' | 'mkfifo', args: readonly string[], timeoutMs = 5000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('非法命令期限');
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      },
    });
    let settled = false;
    let stopping = false;
    let closed = false;
    let failure: unknown;
    let bytes = 0;
    let diagnostic = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      clearInterval(poll);
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure ??= error;
      }
    };
    // 只有 close 和进程组消失同时满足才放弃所有权，直接 Git 退出不代表 upload-pack 等后代已经退出。
    const check = () => {
      if (settled) return;
      try {
        if (!closed || !gone(child.pid)) return;
        settled = true;
        cleanup();
        if (failure !== undefined) reject(failure);
        else resolveCommand();
      } catch (error) {
        stop(error);
      }
    };
    const stop = (error: unknown) => {
      failure ??= error;
      if (stopping || settled) return;
      stopping = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        reapTimer = setTimeout(() => {
          check();
          if (settled) return;
          settled = true;
          cleanup();
          retainedDirectories.add(resolve(cwd));
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(new Error(`无法确认测试进程组回收，PGID=${child.pid ?? '未知'}，保留 fixture：${cwd}`, {cause: failure}));
        }, 1000);
      }, 200);
    };
    const deadline = setTimeout(() => stop(new Error(`${command} 超过 ${timeoutMs}ms 总截止`)), timeoutMs);
    const poll = setInterval(check, 10);
    child.on('error', stop);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', stop);
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) stop(new Error('测试命令输出超过 64 KiB'));
        else diagnostic += chunk.toString('utf8');
      });
    }
    child.once('close', (code, signal) => {
      closed = true;
      if (code !== 0) stop(new Error(`${command} 失败：${code}/${signal} ${diagnostic}`));
      check();
    });
  });
}
