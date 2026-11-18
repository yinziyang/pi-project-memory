import { runAuthoringHost } from "./host.mjs";
// 此入口只由可信宿主启动，参数和私有 stdio 不注册为 Pi 模型工具。
// 所有运行异常只输出固定事件，runAuthoringHost 负责先取消、等待 consumer 再关闭 SQLite。
// 入口的统一清理预算为 2 秒，超时报告未完成并终止本隔离进程，父宿主仍须确认实际回收。
let shutdownDeadline;
function onStopping() {
  shutdownDeadline ??= setTimeout(() => {
    process.stderr.write('{"kind":"HOST_SHUTDOWN_UNCONFIRMED"}\n');
    process.exit(1);
  }, 2000);
}
process.stderr.on("error", () => {
  process.exitCode = 1;
  onStopping();
});
try {
  if (process.argv.length !== 6) {
    throw new Error("HOST_ARGUMENTS");
  }
  await runAuthoringHost({ onStopping, rootPath: process.argv[2], project: process.argv[3], projectPath: process.argv[4], endpointUrl: process.argv[5] });
} catch {
  onStopping();
  process.exitCode = 1;
  await new Promise((resolve) => process.stderr.write('{"kind":"HOST_START_FAILED"}\n', () => resolve()));
} finally {
  clearTimeout(shutdownDeadline);
}
