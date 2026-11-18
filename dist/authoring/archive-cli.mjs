import { runAuthoringHost } from './host.mjs';
import { assertSeparatedDirectories } from './private-directory.mjs';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';

// 入口总收尾预算覆盖启动失败、正常关闭和信号路径，最终回收仍由专用 subreaper 确认。
let deadline;
function onStopping() {
  deadline ??= setTimeout(() => {
    process.stderr.write('{"kind":"ARCHIVE_SHUTDOWN_UNCONFIRMED"}\n');
    process.exit(1);
  }, 2000);
}
process.stderr.on('error', () => { process.exitCode = 1; onStopping(); });
try {
  if (process.argv.length !== 6) throw new Error('ARCHIVE_ARGUMENTS');
  const [rootPath, project, projectPath, worktree] = process.argv.slice(2);
  if (resolve(rootPath) !== rootPath || !/^[a-f0-9]{64}$/.test(worktree) || basename(rootPath) !== worktree ||
      !project.isWellFormed() || !project.trim() || project.includes('\0') || Buffer.byteLength(project) > 256) throw new Error('ARCHIVE_ARGUMENTS');
  // 角色只由可信父进程的专用环境指定，缺省保留原 archive-only，不透传给模型或项目配置。
  const role = process.env.LOCAL_MEMORY_HOST_ROLE ?? 'archive-only';
  if (!['archive-only', 'assistant-local'].includes(role)) throw new Error('ARCHIVE_ROLE');
  const privateRoot = dirname(rootPath);
  // 必须在首次创建私有目录前验证项目分离，所有同步 FS 均处于父进程有界终止的 Bun 子树内。
  assertSeparatedDirectories(privateRoot, projectPath);
  try { mkdirSync(privateRoot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new Error('CAPTURE_ROOT'); }
  const stat = lstatSync(privateRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || realpathSync(privateRoot) !== privateRoot) throw new Error('CAPTURE_ROOT_UNSAFE');
  await runAuthoringHost({ rootPath, project, projectPath, worktree, archiveOnly: true, assistantLocal: role === 'assistant-local', onStopping });
} catch (error) {
  onStopping();
  process.exitCode = 1;
  const kind = error.message === 'WRITER_BUSY' ? 'ARCHIVE_WRITER_BUSY' : 'ARCHIVE_FAILED';
  await new Promise(resolve => process.stderr.write(JSON.stringify({ kind }) + '\n', resolve));
} finally { clearTimeout(deadline); }
