import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {loadProjectMemory} from '../src/project-memory.ts';
import {removeFixture, runFixtureCommand} from './helpers/command.ts';

const text = (id = 'mem_1', body = '中文事务错误释放连接。 English Transaction evidence.') => `---\nschema_version: 1\nid: ${id}\nkind: lesson\nstatus: active\nverification: unverified\nsession_id: synthetic-session\nsource_record: synthetic/observation/1\nbase_commit: synthetic-base\n---\n${body}\n`;

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project-memory-'));
  t.after(() => removeFixture(root));
  await mkdir(join(root, '.project-memory/memories'), {recursive: true});
  await writeFile(join(root, '.project-memory/config.json'), JSON.stringify({schema_version: 1, project_id: 'project_test'}));
  return root;
}

function load(root: string) {
  return loadProjectMemory(root, {signal: new AbortController().signal});
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await runFixtureCommand(cwd, 'git', args);
}

async function snapshot(root: string): Promise<string[]> {
  const names = (await readdir(root, {recursive: true})).sort();
  const result: string[] = [];
  for (const name of names) {
    if (name.endsWith('.json') || name.endsWith('.md')) result.push(`${name}:${(await readFile(join(root, name))).toString('hex')}`);
    else result.push(name);
  }
  return result;
}

test('干净 Git 克隆仅凭共享文本读取、中英文搜索且不写入', {timeout: 20000}, async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.project-memory/memories/a.md'), text());
  await git(root, 'init', '-q');
  await git(root, 'add', '.project-memory');
  await git(root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic');
  const clone = join(root, 'clean-clone');
  await git(root, 'clone', '--quiet', '--no-local', root, clone);
  const before = await snapshot(clone);
  const memory = await load(clone);
  assert.equal(memory.projectId, 'project_test');
  assert.deepEqual(memory.search('中文 事务').map(r => r.id), ['mem_1']);
  assert.deepEqual(memory.search('TRANSACTION evidence').map(r => r.id), ['mem_1']);
  assert.equal(memory.search('不存在').length, 0);
  assert.equal(memory.search('').length, 0);
  assert.equal(memory.read('mem_1')?.archive, 'not_loaded');
  assert.equal(memory.read('missing'), undefined);
  assert.equal(Object.isFrozen(memory.records), true);
  assert.deepEqual(await snapshot(clone), before);
});

test('空库合法，未初始化目录报错', async t => {
  const root = await fixture(t);
  assert.equal((await load(root)).records.length, 0);
  await assert.rejects(load(join(root, 'missing')), /ENOENT/);
  await rm(join(root, '.project-memory'), {recursive: true});
  await assert.rejects(load(root), /ENOENT/);
});

test('相同 ID 冲突，不覆盖，结果按 ID 稳定排序', async t => {
  const root = await fixture(t);
  const path = join(root, '.project-memory/memories');
  await writeFile(join(path, 'b.md'), text('z'));
  await writeFile(join(path, 'a.md'), text('a'));
  assert.deepEqual((await load(root)).search('中文').map(r => r.id), ['a', 'z']);
  await writeFile(join(path, 'b.md'), text('a'));
  await assert.rejects(load(root), /重复记忆 ID/);
});

test('拒绝坏 schema、YAML、UTF8、Unicode、类型和大小', async t => {
  const root = await fixture(t);
  const file = join(root, '.project-memory/memories/a.md');
  const cases = [
    text().replace('schema_version: 1', 'schema_version: 2'),
    text().replace('id: mem_1', 'id: a\nid: b'),
    text().replace('id: mem_1', 'id: &key mem_1\ntask_id: *key'),
    text().replace('kind: lesson', 'kind: [lesson]'),
    text().replace('id: mem_1', 'id: "\\uD800"'),
    text().replace('id: mem_1', 'id: mem_1\nscope: {"\\uD800": value}'),
    text().replace('id: mem_1', 'id: mem_1\nscope: {[a, b]: value}'),
    text().replace('id: mem_1', 'id: ../escape'),
    text().replace('status: active', 'unknown: x\nstatus: active'),
    text().replace('verification: unverified', 'verification: false'),
    text('mem_1', ''),
    Buffer.from([0xff, 0xfe]),
    Buffer.alloc(1024 * 1024 + 1, 65),
  ];
  for (const bad of cases) {
    await writeFile(file, bad);
    await assert.rejects(load(root));
  }
  await rm(file);
  await writeFile(join(root, '.project-memory/config.json'), '{"schema_version":2,"project_id":"test"}');
  await assert.rejects(load(root), /schema_version/);
});

test('不展开外部来源，不执行正文', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.project-memory/memories/a.md'), text().replace('synthetic/observation/1', '/outside/original.sqlite').replace('中文事务', 'touch /never-created 中文事务'));
  assert.equal((await load(root)).records.length, 1);
  assert.deepEqual((await readdir(root)).sort(), ['.project-memory']);
});

test('拒绝文件、受管目录、根祖先软链接及非普通候选', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, 'secret.md'), text());
  const candidate = join(root, '.project-memory/memories/a.md');
  await symlink(join(outside, 'secret.md'), candidate);
  await assert.rejects(load(root), /ELOOP/);
  await rm(candidate);
  await mkdir(candidate);
  await assert.rejects(load(root), /非普通文件/);
  await rm(candidate, {recursive: true});
  const linkedRoot = join(outside, 'linked');
  await symlink(root, linkedRoot);
  await assert.rejects(load(linkedRoot));
  await rm(join(root, '.project-memory/memories'), {recursive: true});
  await symlink(outside, join(root, '.project-memory/memories'));
  await assert.rejects(load(root));
});

test('FIFO 候选不会在 open 阶段阻塞', {timeout: 5000}, async t => {
  const root = await fixture(t);
  const fifo = join(root, '.project-memory/memories/fifo.md');
  await runFixtureCommand(root, 'mkfifo', [fifo], 2000);
  await assert.rejects(load(root), /非普通文件/);
});

test('预取消和加载进行中的取消均拒绝且不继续返回结果', async t => {
  const root = await fixture(t);
  const pre = AbortSignal.abort(new Error('pre-cancel'));
  await assert.rejects(loadProjectMemory(root, {signal: pre}), /pre-cancel/);
  for (let i = 0; i < 20; i++) await writeFile(join(root, `.project-memory/memories/m${i}.md`), text(`mem_${i}`, '中文'.repeat(10000)));
  const controller = new AbortController();
  const pending = loadProjectMemory(root, {signal: controller.signal});
  setImmediate(() => controller.abort(new Error('during-cancel')));
  await assert.rejects(pending, /during-cancel/);
  assert.equal((await load(root)).records.length, 20);
});
