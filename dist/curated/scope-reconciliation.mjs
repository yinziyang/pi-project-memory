import { observeCheckout } from './checkout-snapshot.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function publicIdentity(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'fileIdentity,generation,paused,project,scope,stable' ||
      typeof value.project !== 'string' || !value.project || !value.project.isWellFormed() || value.project.length > 512 ||
      !hash(value.scope) || !hash(value.generation) || value.stable !== true || typeof value.paused !== 'boolean' ||
      typeof value.fileIdentity !== 'string' || !value.fileIdentity || value.fileIdentity.length > 1024 || !value.fileIdentity.isWellFormed()) throw new Error('SCOPE_PUBLIC_IDENTITY');
  return { project: value.project, scope: value.scope, generation: value.generation, fileIdentity: value.fileIdentity, paused: value.paused, stable: true };
}

/** 在每次工具读取和 context 恢复前撤销旧候选，再观察 checkout 与公开文件身份并加载新周期。
 * observePublic 必须由可信宿主检查公开数据库及 paused marker，fileIdentity 须包含文件替换身份而非只含 generation。
 * loadPublic 必须绑定传入身份读取并校验真实投影，不能将 model 参数作为新 project/path 选择。
 * 所有 I/O 借用同一 owner 的可取消有界实现，close 等待其真实停止，本模块不新建或关闭数据库 owner。
 * Git 观察不是跨命令原子快照，dirtyDigest 不是内容 hash，stable=false 时一律撤销而不声称代码事实已核验。
 */
export function createScopeReconciliation({ cwd, project, scope, observePublic, loadPublic, revokeCandidates, observe = observeCheckout, budgetMs = 2000, clock = performance.now.bind(performance) }) {
  if (typeof cwd !== 'string' || !cwd || typeof project !== 'string' || !project || !hash(scope) || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 5000) throw new Error('SCOPE_CONFIG');
  let epoch = 0;
  let stopped = false;
  let active = null;
  let current = null;
  let state = 'unavailable';
  function revoke() {
    // 先推进控制状态，即使外部撤销回调抛错，也不会继续承认旧周期有效。
    epoch += 1;
    current = null;
    state = stopped ? 'closed' : 'unavailable';
    active?.controller.abort();
    revokeCandidates();
    return epoch;
  }
  async function identities(signal) {
    signal.throwIfAborted();
    const checkout = await observe(cwd, signal);
    signal.throwIfAborted();
    const publication = publicIdentity(await observePublic({ signal }));
    signal.throwIfAborted();
    if (!checkout || checkout.stable !== true || !hash(checkout.worktree) || publication.project !== project || publication.scope !== scope || publication.paused) throw new Error('SCOPE_UNAVAILABLE');
    // 不保留由第三方可变对象引用构成的快照，不把真实路径扩散进工具结果。
    const { worktree, commit, tree, dirtyDigest, dirty, detached, unborn, kind, stable } = checkout;
    return { checkout: { worktree, commit, tree, dirtyDigest, dirty, detached, unborn, kind, stable }, publication };
  }
  function valid(ticket) { return !stopped && ticket === epoch && current !== null; }
  async function preflight(signal) {
    if (stopped) return { state: 'closed' };
    // 并发新请求也立即撤销旧周期，但不启动第二个后台 I/O 或等待无界队列。
    let ticket;
    try { ticket = revoke(); } catch { return { state: 'unavailable' }; }
    if (active) return { state: 'busy' };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const started = clock();
    const timer = setTimeout(cancel, budgetMs);
    const promise = (async () => {
      try {
        const before = await identities(controller.signal);
        const loaded = await loadPublic({ checkout: before.checkout, publication: before.publication, ticket, signal: controller.signal });
        const after = await identities(controller.signal);
        if (stopped || epoch !== ticket || controller.signal.aborted || clock() - started > budgetMs || !equal(before, after)) return { state: 'unavailable' };
        current = { identities: after, loaded };
        state = 'ready';
        return { state, ticket, project, worktree: after.checkout.worktree, generation: after.publication.generation, loaded,
          isCurrent: () => valid(ticket),
          // 工具/私有读取在返回结果前再次观察，晚结果不得在 checkout 或同代文件替换后恢复权限。
          verify: async ({ signal: verifySignal } = {}) => {
            if (active || !valid(ticket)) return false;
            const verifier = new AbortController();
            const abort = () => verifier.abort();
            verifySignal?.addEventListener('abort', abort, { once: true });
            if (verifySignal?.aborted) verifier.abort();
            const verifyStarted = clock();
            const verifyTimer = setTimeout(abort, budgetMs);
            const verification = (async () => {
              try {
                const latest = await identities(verifier.signal);
                if (!verifier.signal.aborted && clock() - verifyStarted <= budgetMs && valid(ticket) && equal(after, latest)) return true;
              } catch {
                // 所有失败都撤销当前周期，不把原始路径、SQL 或 Git 错误带入模型消息。
              }
              if (ticket === epoch) {
                try { revoke(); } catch { /* 内部状态已先撤销，回调错误不能恢复旧周期。 */ }
              }
              return false;
            })();
            active = { controller: verifier, promise: verification };
            try { return await verification; } finally {
              clearTimeout(verifyTimer);
              verifySignal?.removeEventListener('abort', abort);
              active = null;
            }
          }
        };
      } catch {
        return { state: 'unavailable' };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    })();
    active = { controller, promise };
    try { return await promise; } finally { active = null; }
  }
  return Object.freeze({
    preflight: ({ signal } = {}) => preflight(signal),
    invalidate() { try { revoke(); } catch { /* 撤销结果仍为不可读，调用方可通过 status 观察。 */ } },
    status() { return { state, ticket: epoch, inFlight: active !== null, ready: current !== null }; },
    async close() {
      stopped = true;
      const pending = active;
      try { revoke(); } catch { /* 退出必须继续等待已启动工作回收。 */ }
      if (pending) await pending.promise;
    }
  });
}
