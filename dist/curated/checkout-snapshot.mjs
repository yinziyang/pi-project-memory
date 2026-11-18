import { createTrustedObservationOwner, assertTrustedObservationOwnersClosed } from './trusted-observation-owner.mjs';

/** 确认没有跨 reload 保留的未知观察子树，不把发送取消当作实际关闭。 */
export function assertCheckoutReadersClosed() {
  assertTrustedObservationOwnersClosed();
}

/** 单次独立 checkout 观察，所有 native FS 与 Git 均在专用观察子树中执行，返回前实际关闭子树。
 * 正式 Pi 实例应借用长寿命观察 owner 的 checkout 方法，避免每次检查重复启动进程。
 * 取消和截止会终止并等待实际子树，无法确认的进程被保留并阻止下一次启动，不承诺内核永久 D 状态一定可杀死。
 */
export async function observeCheckout(cwd, signal) {
  signal?.throwIfAborted();
  const owner = await createTrustedObservationOwner({ cwd });
  try { return await owner.checkout({ signal }); }
  finally { await owner.close(); }
}

/** 私有来源只保存路径的工作树身份摘要，不把真实路径、分支名或 git stderr 放入 envelope 或日志。 */
export function checkoutBinding(snapshot) {
  const { canonicalCwd, root, gitDir, commonDir, ...binding } = snapshot;
  return Object.freeze(binding);
}
