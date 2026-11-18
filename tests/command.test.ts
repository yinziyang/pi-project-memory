import assert from 'node:assert/strict';
import {mkdtemp, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {removeFixture, runFixtureCommand} from './helpers/command.ts';

test('Git 测试命令不继承 GIT_CONFIG_COUNT 等外部配置', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-git-env-'));
  t.after(() => removeFixture(root));
  const previous = process.env.GIT_CONFIG_COUNT;
  try {
    process.env.GIT_CONFIG_COUNT = 'invalid-external-config';
    await runFixtureCommand(root, 'git', ['init', '-q']);
    await access(join(root, '.git'));
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previous;
  }
});

test('Git 命令失败传播错误且回收后才能清理 fixture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-git-fail-'));
  t.after(() => removeFixture(root));
  await assert.rejects(runFixtureCommand(root, 'git', ['--not-a-real-option']), /git 失败/);
  await runFixtureCommand(root, 'git', ['init', '-q']);
  await runFixtureCommand(root, 'git', ['-c', 'alias.child=!true', 'child']);
});
