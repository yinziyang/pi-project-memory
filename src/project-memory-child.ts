import {readProjectMemory} from './project-memory-reader.ts';

// 此入口不继承调用方环境或执行记忆文本，所有句柄仅归本进程，父进程负责必要时强制回收。
try {
  const root = process.argv[2];
  if (root === undefined) throw new Error('缺少项目根目录');
  const memory = await readProjectMemory(root, {signal: new AbortController().signal});
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify({projectId: memory.projectId, records: memory.records}), error => error ? reject(error) : resolve());
  });
} catch (error) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message.slice(0, 4096));
}
