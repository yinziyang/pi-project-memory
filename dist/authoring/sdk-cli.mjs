import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { runAuthoringHost } from "./host.mjs";
import { createSdkGenerator } from "./sdk-generator.mjs";
// 生产入口只在显式发送已批准任务时通过 SDK 正常认证 API 取用配置，不在启动时预检或调用远端。
const adapter = createSdkGenerator({ sdkModuleUrl: pathToFileURL(join(process.argv[5] ?? "", "dist/index.js")).href });
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
  await runAuthoringHost({ onStopping, rootPath: process.argv[2], project: process.argv[3], projectPath: process.argv[4], generate: adapter.generate, closeGenerator: adapter.close });
} catch {
  onStopping();
  process.exitCode = 1;
  await new Promise((resolve) => process.stderr.write('{"kind":"HOST_FAILED"}\n', () => resolve()));
} finally {
  clearTimeout(shutdownDeadline);
}
