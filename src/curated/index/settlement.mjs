export const INDEX_CANCEL_SETTLE_MS = 3500;
export const INDEX_CLOSE_SETTLE_MS = 5000;

/** 仅为已由 owner 强引用登记的真实任务提供有界等待，期限届满只能失败，不能解释为底层工作停止。
 * 取消后给固定 3500 毫秒收尾窗口，close 使用调用方从入口建立的绝对 deadline，先到者生效。
 * 未确认时先同步关门并保留资源，再拒绝等待者，真实 promise 的结果处理器始终保留以消费晚结果。
 */
export function waitIndexSettlement(task, { signal, deadline = Infinity, code, onUnconfirmed }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    let due = deadline;
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const expire = () => {
      if (finished) return;
      finished = true;
      clear();
      const error = new Error(code);
      try { onUnconfirmed?.(error); }
      catch (failure) { error.cause = failure; }
      reject(error);
    };
    const arm = () => {
      clearTimeout(timer);
      if (Number.isFinite(due)) timer = setTimeout(expire, Math.max(0, due - performance.now()));
    };
    const abort = () => { due = Math.min(due, performance.now() + INDEX_CANCEL_SETTLE_MS); arm(); };
    Promise.resolve(task).then(value => {
      if (finished) return;
      finished = true;
      clear();
      if (signal?.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      if (finished) return;
      finished = true;
      clear();
      reject(error);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else arm();
  });
}
