// 依赖诊断只送固定事件到专用worker的stderr，不初始化上游日志器或读取全局settings。
// 不复制消息、对象或异常原文，bridge owner 继续持有真实进程状态与字节限额。
function warning() {
  process.stderr.write('SESSION_SEARCH_DIAGNOSTIC\n');
}
export const logger = Object.freeze({
  debug() {},
  info() {},
  warn: warning,
  error: warning
});
