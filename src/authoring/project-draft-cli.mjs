// 可信 supervisor 专用入口，传入规范的项目根和继承的目录锁描述符。
// 调用方必须等待监督进程回收完成才可使用响应，没有确认时不得盲重试。
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { fstatSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCurrentCuration } from '../curated/current-curation.mjs';
import { exactFields, readDraftFrame, text, validDraft } from './draft-wire.mjs';
import { CATEGORIES, stageReviewedDrafts } from './knowledge-curation.mjs';
import { exportMarkdown } from './markdown-export.mjs';

const SWAP = fileURLToPath(new URL('./publication-swap.py', import.meta.url));
const GENERATION = /^[0-9a-f]{64}$/;

class Rejection extends Error {}

function helper(payload, args = []) {
  return spawnSync('python3', [SWAP, ...args], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 6000, killSignal: 'SIGKILL', maxBuffer: 8192,
  });
}

function readSnapshot(path, project, operation) {
  const db = new Database(path, operation ? { readwrite: true, create: false } : { readonly: true });
  try {
    const snapshot = readCurrentCuration(db, { project });
    return operation ? operation(db, snapshot) : snapshot;
  } finally {
    db.close();
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function stageDrafts(target, baseline, options) {
  if (baseline === null) return stageReviewedDrafts(null, options);
  const source = new Database(target, { readonly: true });
  try {
    return stageReviewedDrafts(source, options);
  } finally {
    source.close();
  }
}

function publish(parent, { project, generation, drafts }) {
  const stage = join(parent, '.project-memory-next');
  const marker = join(parent, '.project-memory-paused');
  const target = join(parent, '.project-memory', 'knowledge.sqlite');
  const stagedDb = join(stage, 'knowledge.sqlite');
  const recovery = () => new Rejection('PROJECT_DRAFT_RECOVERY_REQUIRED');
  if (exists(stage) || readdirSync(parent).some(name => name.startsWith('.project-memory-retained-'))) throw recovery();

  // 旧宿主校验暂停标记的内容而不持有目录锁，因此直发必须独占创建与旧暂停凭证不同的标记。
  // 不认领任何既有标记，也不能代替旧宿主声明其 reader 已停止。
  try {
    writeFileSync(marker, 'local-project-memory-project-draft-v1\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST' || exists(marker)) throw recovery();
    throw error;
  }
  let ownsStage = false;
  let retain = false;
  try {
    const check = helper({ project, parent }, ['inspect']);
    if (check.error || check.status !== 0) throw new Rejection('PROJECT_DRAFT_UNAVAILABLE');
    const { generation: baseline } = JSON.parse(check.stdout);
    if (baseline !== generation) throw new Rejection('CURATION_CONFLICT');
    if (baseline !== null) {
      try {
        if (readSnapshot(target, project).generation !== baseline) throw new Error();
      } catch {
        throw new Rejection('PROJECT_DRAFT_UNAVAILABLE');
      }
    }
    try {
      mkdirSync(stage, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      retain = true;
      throw recovery();
    }
    ownsStage = true;
    stageDrafts(target, baseline, { project, generation, targetPath: stagedDb, drafts, reviewedAt: new Date().toISOString() });
    const result = readSnapshot(stagedDb, project, (db, snapshot) => {
      exportMarkdown(db, { project, parentPath: stage, exclusiveSourcePath: true, timeoutMs: 6000 });
      return { generation: snapshot.generation, count: drafts.length };
    });
    unlinkSync(join(stage, '.md-export.lock'));
    writeFileSync(join(stage, 'curated.json'), JSON.stringify({ version: 1, project, generation: result.generation }) + '\n', { flag: 'wx', mode: 0o600 });

    // 交换之前的失败可撤除自有暂存，交换启动后必须用可信回执区分未提交和可能已经提交。
    retain = true;
    const swapped = helper({ project, parent, generation });
    if (!swapped.error && swapped.status === 1 && swapped.stderr === 'PUBLICATION_NOT_COMMITTED\n') {
      retain = false;
      throw new Rejection('PROJECT_DRAFT_FAILED');
    }
    if (swapped.error || swapped.status !== 0) throw recovery();
    const receipt = JSON.parse(swapped.stdout);
    if (receipt.stage !== 'committed' || receipt.generation !== result.generation
        || receipt.cleanup !== (generation === null ? 'none' : 'removed')) throw recovery();
    ownsStage = false;
    retain = false;
    return result;
  } catch (error) {
    if (retain || error?.retainedResources?.length) {
      retain = true;
      throw recovery();
    }
    throw error;
  } finally {
    if (!retain) {
      try {
        if (ownsStage) rmSync(stage, { recursive: true });
        unlinkSync(marker);
      } catch {
        throw recovery();
      }
    }
  }
}

async function run() {
  const [cwd, descriptor] = process.argv.slice(2);
  try {
    if (process.argv.length !== 4 || realpathSync(cwd) !== cwd || !/^[0-9]+$/.test(descriptor)) throw new Error();
    const dir = lstatSync(cwd);
    const locked = fstatSync(Number(descriptor));
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o022) !== 0
        || dir.dev !== locked.dev || dir.ino !== locked.ino) throw new Error();
  } catch {
    throw new Rejection('PROJECT_DRAFT_UNAVAILABLE');
  }
  const inputDeadline = setTimeout(() => process.stdin.destroy(new Error('PROJECT_DRAFT_INPUT')), 4000);
  let request;
  try {
    request = await readDraftFrame();
  } catch {
    throw new Rejection('PROJECT_DRAFT_INPUT');
  } finally {
    clearTimeout(inputDeadline);
  }
  if (!exactFields(request, ['project', 'generation', 'drafts']) || !text(request.project)
      || Buffer.byteLength(request.project) > 256 || !(request.generation === null
        || (typeof request.generation === 'string' && GENERATION.test(request.generation) && request.generation.length === 64))
      || !Array.isArray(request.drafts) || request.drafts.length < 1 || request.drafts.length > 5
      || !request.drafts.every(draft => validDraft(draft, CATEGORIES))) throw new Rejection('PROJECT_DRAFT_INPUT');
  return publish(cwd, request);
}

// 默认终止信号由 supervisor 回收本进程及 helper，若已开始文件操作则保留实际可见的中断标记。
try {
  let response;
  try {
    response = { ok: true, result: await run() };
  } catch (error) {
    process.exitCode = 1;
    const code = error instanceof Rejection || ['CURATION_CONFLICT', 'CURATION_UNCHANGED'].includes(error?.message)
      ? error.message : 'PROJECT_DRAFT_FAILED';
    response = { ok: false, code };
  }
  await new Promise(resolve => process.stdout.write(JSON.stringify(response) + '\n', error => {
    if (error) process.exitCode = 1;
    resolve();
  }));
} finally {
  process.stdin.destroy();
}
