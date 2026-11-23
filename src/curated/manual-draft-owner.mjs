import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jobs = globalThis[Symbol.for('local-project-memory.manual-draft.jobs.v1')] ??= new Map();

/** 以固定私库启动一次监督写入，只有收到子树回收凭证并取得成功帧才确认提交。 */
export function startManualDraft({ binding, checkout }, draft) {
  const directory = join(binding.privateRoot, checkout.worktree);
  return startJob(directory, [binding.bunPath ?? 'bun', 'manual-draft', directory, binding.project, binding.cwd], draft,
    frame => frame.result?.revision === draft.expectedRevision + 1);
}

/** 在受监督进程中整批保存已确认的项目草稿，未确认提交时保留任务所有权。 */
export function startProjectDraft({ cwd, project, generation }, drafts) {
  return startJob(cwd, ['bun', 'project-draft', cwd], { project, generation, drafts },
    frame => frame.result?.count === drafts.length && typeof frame.result.generation === 'string' && /^[a-f0-9]{64}$/.test(frame.result.generation), 34000);
}

function startJob(directory, args, payload, confirms, timeoutMs = 19000) {
  if (jobs.has(directory)) throw new Error('MEMORY_DRAFT_BUSY');
  const supervisor = fileURLToPath(new URL('../authoring/supervise.py', import.meta.url));
  const child = spawn('python3', [supervisor, ...args], {
    stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', LOCAL_MEMORY_REAP_FD: '3' },
  });
  let output = '';
  let proof = '';
  let bad = false;
  let inputClosed = false;
  let spawnFailed = false;
  const stop = () => { child.kill('SIGTERM'); };
  let complete;
  const reaped = new Promise(resolve => { complete = resolve; });
  let deliver;
  const result = new Promise(resolve => { deliver = resolve; });
  const timer = setTimeout(() => { stop(); deliver({ code: 'MEMORY_DRAFT_COMMIT_UNCONFIRMED' }); }, timeoutMs);
  const job = { result, async close() {
    stop();
    let timeout;
    try {
      if (!await Promise.race([reaped, new Promise(resolve => { timeout = setTimeout(() => resolve(false), 4000); })])) throw new Error('MEMORY_DRAFT_CLOSE_UNCONFIRMED');
    } finally { clearTimeout(timeout); }
  } };
  jobs.set(directory, job);
  child.on('error', () => { spawnFailed = child.pid === undefined; });
  function failPipe() { bad = true; stop(); }
  child.stdin.on('error', error => {
    // 写宿主可能在读取请求前就拒绝取锁；EPIPE 不抹除明确拒绝帧，但不能作为成功提交。
    if (error.code === 'EPIPE') inputClosed = true;
    else failPipe();
  });
  child.stdout.on('error', failPipe);
  child.stdio[3].on('error', failPipe);
  child.stdout.on('data', bytes => { if (!bad && (output += bytes).length > 1024) failPipe(); });
  child.stdio[3].on('data', bytes => { if (proof.length < 32 && (proof += bytes).length > 32) failPipe(); });
  child.on('close', code => {
    clearTimeout(timer);
    const confirmed = spawnFailed || proof === 'REAP_CONFIRMED\n';
    if (confirmed) jobs.delete(directory);
    complete(confirmed);
    if (spawnFailed) return deliver({ code: 'MEMORY_DRAFT_UNAVAILABLE' });
    if (!confirmed || bad) return deliver({ code: 'MEMORY_DRAFT_COMMIT_UNCONFIRMED' });
    let frame;
    try { frame = JSON.parse(output); } catch { return deliver({ code: 'MEMORY_DRAFT_COMMIT_UNCONFIRMED' }); }
    if (!inputClosed && code === 0 && frame?.ok === true && confirms(frame)) return deliver(frame.result);
    const safe = new Set(['CURATION_CONFLICT', 'MANUAL_DRAFT_INPUT', 'MANUAL_DRAFT_LIBRARY', 'MANUAL_DRAFT_BUSY', 'MANUAL_DRAFT_ARGUMENTS',
      'PROJECT_DRAFT_BUSY', 'PROJECT_DRAFT_INPUT', 'PROJECT_DRAFT_UNAVAILABLE', 'PROJECT_DRAFT_RECOVERY_REQUIRED', 'PROJECT_DRAFT_FAILED', 'CURATION_UNCHANGED']);
    const error = frame?.code ?? frame?.error;
    return deliver({ code: safe.has(error) ? error : 'MEMORY_DRAFT_COMMIT_UNCONFIRMED' });
  });
  child.stdin.end(`${JSON.stringify(payload)}\n`);
  return job;
}
