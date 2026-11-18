import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {loadProjectMemory, MemoryProcessCleanupError} from '../src/project-memory.ts';

test('config 拒绝重复键及转义后重复键', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.project-memory/memories'), {recursive: true});
  for (const config of [
    '{"schema_version":1,"project_id":"a","project_id":"b"}',
    '{"schema_version":1,"project_id":"a","project_\\u0069d":"b"}',
    '{"schema_version":2,"schema_version":1,"project_id":"a"}',
  ]) {
    await writeFile(join(root, '.project-memory/config.json'), config);
    await assert.rejects(loadProjectMemory(root, {signal: new AbortController().signal}), /重复键/);
  }
});

test('memories 第1001项即拒绝', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-limit-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.project-memory/memories'), {recursive: true});
  await writeFile(join(root, '.project-memory/config.json'), '{"schema_version":1,"project_id":"a"}');
  for (let i = 0; i <= 1000; i++) await writeFile(join(root, `.project-memory/memories/a${i}.md`), '');
  await assert.rejects(loadProjectMemory(root, {signal: new AbortController().signal}), /超过 1000/);
});

async function childPids(): Promise<number[]> {
  const text = await readFile(`/proc/self/task/${process.pid}/children`, 'utf8');
  return text.trim().split(/\s+/u).filter(Boolean).map(Number);
}

for (const scenario of ['cancel', 'deadline']) {
  test(`读取进程被 SIGSTOP 后通过 ${scenario} 强杀并确认回收`, {timeout: 15000}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'memory-stopped-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const before = new Set(await childPids());
    const controller = new AbortController();
    const outcome = loadProjectMemory(root, {signal: controller.signal}).then(
      () => new Error('不应成功'), error => error,
    );
    let pid: number | undefined;
    try {
      const cutoff = performance.now() + 1000;
      while (pid === undefined && performance.now() < cutoff) {
        pid = (await childPids()).find(value => !before.has(value));
        if (pid === undefined) await setImmediate();
      }
      assert.notEqual(pid, undefined, '必须在期限内观察到读取进程启动');
      if (pid === undefined) throw new Error('读取进程未启动');
      process.kill(pid, 'SIGSTOP');
      if (scenario === 'cancel') controller.abort(new Error('stopped-cancel'));
      const error: unknown = await outcome;
      assert.ok(error instanceof Error);
      assert.equal(error instanceof MemoryProcessCleanupError, false, '必须真正回收，不能仅报告强杀已发送');
      assert.match(error.message, scenario === 'cancel' ? /stopped-cancel/ : /10 秒总截止/);
      const stoppedPid = pid;
      assert.throws(() => process.kill(stoppedPid, 0), /ESRCH/);
    } finally {
      controller.abort(new Error('test cleanup'));
      await outcome;
    }
  });
}
