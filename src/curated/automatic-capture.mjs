import { createTrustedObservationOwner } from './trusted-observation-owner.mjs';
import { captureSessionPath } from './session-capture.mjs';
import { observeCheckout, checkoutBinding, assertCheckoutReadersClosed } from './checkout-snapshot.mjs';
import { createCaptureOwner, assertCaptureOwnersClosed } from './capture-owner.mjs';

async function isolatedCaptureConfig(cwd) {
  const owner = await createTrustedObservationOwner({ cwd });
  try { return await owner.captureConfig(); } finally { await owner.close(); }
}

/** 自动采集只拥有过滤快照、有界队列和单一 archive owner，不向模型暴露配置、路径或写入操作。
 * 每实例最多排队 8 个快照且总计 4MiB，共享串行 IPC 租约另最多排队 8 项，回执最多保留当前周期 64 项，仅 committed 表示实际事务已提交。
 * observe、makeOwner、readConfig 缺省使用正式实现，测试注入仍须遵守取消与资源所有权，不创建新的公开配置入口。
 * shutdown 停止接收并舍弃尚未发出的队列，标记 gap，取消 Git 并关闭实际 owner，不声称丢弃分支可从公开 SDK 恢复。
 * readStatus 只把 owner 已确认关闭的主动取消转为 null，真实 IPC 与关闭错误仍向调用方传播。
 * 每次观察绑定自身 leaf、ticket 与 checkout；晚到旧轮仍可私有归档，但不能改变新周期状态或公开 reader。
 */
export function createAutomaticCapture({ readPublicBinding, readTaskBinding = readPublicBinding, observe: checkoutObserver = observeCheckout, makeOwner = createCaptureOwner, readConfig = isolatedCaptureConfig, onCommitted = () => {} }) {
  let config = null;
  let owner;
  let currentWorktree;
  let ownerBinding;
  let readerCheckout;
  let accepting = true;
  let paused = false;
  let ticket = 0;
  let bytes = 0;
  let queue = [];
  let running;
  let closing;
  let faults = false;
  const controller = new AbortController();
  let receipts = [];
  let exclusiveActive;
  let exclusiveQueue = [];
  let scopeTicket = 0;
  const baselines = new Set();
  function exclusive(work, signal) {
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    if (exclusiveQueue.length >= 8) throw new Error('TASK_BUSY');
    return new Promise((resolve, reject) => {
      const item = { work, resolve, reject, signal: combined };
      item.abort = () => {
        const index = exclusiveQueue.indexOf(item);
        if (index !== -1) {
          exclusiveQueue.splice(index, 1);
          combined.removeEventListener('abort', item.abort);
          reject(new Error('TASK_UNAVAILABLE'));
        }
      };
      combined.addEventListener('abort', item.abort, { once: true });
      exclusiveQueue.push(item);
      drain();
    });
  }
  function drain() {
    if (exclusiveActive || !exclusiveQueue.length) return;
    const item = exclusiveQueue.shift();
    exclusiveActive = item;
    item.promise = (async () => { item.signal.throwIfAborted(); return await item.work(item.signal); })();
    item.promise.then(item.resolve, item.reject).finally(() => {
      item.signal.removeEventListener('abort', item.abort);
      exclusiveActive = undefined;
      drain();
    });
  }
  async function ensureOwner(checkout) {
    const selected = JSON.stringify([config.project, config.cwd, config.privateRoot, config.bunPath]);
    const current = await readConfig(config.cwd);
    if (!current || JSON.stringify([current.project, current.cwd, current.privateRoot, current.bunPath]) !== selected) throw new Error('TASK_DISABLED');
    if (owner && (currentWorktree !== checkout.worktree || ownerBinding !== selected)) { await owner.close(); owner = undefined; }
    if (!owner) {
      owner = await makeOwner(config, checkout, { role: 'assistant-local' });
      currentWorktree = checkout.worktree;
      ownerBinding = selected;
    }
    return owner;
  }
  const checkoutIdentity = value => JSON.stringify([value.worktree, value.commit, value.tree, value.kind]);
  async function releaseResources() {
    const failures = [];
    async function attempt(work) { try { await work(); } catch (error) { failures.push(error); } }
    // 首次 close 失败不能跳过在途任务等待和后续资源回收，失败原样保留到所有收尾步骤完成。
    if (owner) {
      await attempt(() => owner.close());
      // 首次关闭若只报告错误而尚未释放 IPC，立即再次推进收尾，再等待仍借用连接的任务。
      if (failures.length) await attempt(() => owner.close());
    }
    if (running) await attempt(() => running);
    if (exclusiveActive) await attempt(() => exclusiveActive.promise);
    await Promise.allSettled([...baselines]);
    if (owner) await attempt(async () => { await owner.close(); owner = undefined; });
    await attempt(() => assertCheckoutReadersClosed());
    await attempt(() => assertCaptureOwnersClosed());
    if (failures.length) throw new AggregateError(failures, 'CAPTURE_CLOSE_FAILED');
  }
  function record(stamp, state, reason) {
    if (stamp !== ticket) return;
    receipts.push(Object.freeze({ state, ...(reason ? { reason } : {}) }));
    if (receipts.length > 64) receipts.shift();
  }
  function observe(ctx) {
    if (!accepting || paused || !config) return;
    const stamp = ++ticket;
    receipts = [];
    record(stamp, 'observed');
    const snapshot = captureSessionPath(ctx.sessionManager);
    for (const receipt of snapshot.receipts) record(stamp, receipt.state, receipt.reason);
    if (!snapshot.rounds.length) return;
    const size = snapshot.rounds.reduce((total, round) => total + Buffer.byteLength(round.raw), 0);
    if (queue.length >= 8 || bytes + size > 4 * 1024 * 1024) { record(stamp, 'gap', 'QUEUE_BUDGET'); return; }
    // reader 周期只约束 checkout 身份，轮内正常文件编辑允许改变 dirty，归档另在 settled 时取得自己的完整观察基线。
    const baseline = checkoutObserver(config.cwd, controller.signal).catch(() => null).finally(() => baselines.delete(baseline));
    baselines.add(baseline);
    queue.push({ snapshot, stamp, size, config, baseline, expectedReaderIdentity: readerCheckout ? checkoutIdentity(JSON.parse(readerCheckout)) : null });
    bytes += size;
    record(stamp, 'queued');
    kick();
  }
  function kick() {
    if (running || !accepting || paused) return;
    running = (async () => {
      while (queue.length && accepting && !paused) {
        const item = queue.shift();
        bytes -= item.size;
        try {
          const baseline = await item.baseline;
          const checkout = await checkoutObserver(item.config.cwd, controller.signal);
          if (!accepting || paused) break;
          if (!baseline?.stable || !checkout.stable || (item.expectedReaderIdentity && item.expectedReaderIdentity !== checkoutIdentity(baseline)) ||
              JSON.stringify(checkoutBinding(baseline)) !== JSON.stringify(checkoutBinding(checkout))) {
            record(item.stamp, 'gap', 'CHECKOUT_UNSTABLE_OR_CHANGED');
            continue;
          }
          const publicBinding = await readPublicBinding(item.config.cwd);
          if (publicBinding && publicBinding.project !== item.config.project) throw new Error('CAPTURE_PROJECT_MISMATCH');
          await exclusive(async signal => {
            signal.throwIfAborted();
            if (item.config !== config) { record(item.stamp, 'gap', 'CONFIG_CHANGED'); return; }
            const latest = await checkoutObserver(item.config.cwd, signal);
            if (!latest.stable || JSON.stringify(checkoutBinding(latest)) !== JSON.stringify(checkoutBinding(checkout))) {
              record(item.stamp, 'gap', 'CHECKOUT_UNSTABLE_OR_CHANGED');
              return;
            }
            const selected = await ensureOwner(checkout);
            if (!accepting || paused) return;
            for (const round of item.snapshot.rounds) {
              signal.throwIfAborted();
              if (!accepting || paused) { record(item.stamp, 'gap', 'STOPPED_QUEUE'); break; }
              const observation = { worktree: checkout.worktree, leaf: item.snapshot.leaf, ticket: item.stamp,
                checkout: { ...checkoutBinding(checkout), generation: publicBinding?.generation ?? null } };
              await selected.archive(round, observation);
              record(item.stamp, 'committed');
              // 通知只排入状态刷新，不能在持有 IPC 租约时等待再次借用同一 owner。
              onCommitted();
            }
          }, controller.signal);
        } catch (error) {
          faults = true;
          record(item.stamp, error.message === 'CAPTURE_WRITER_BUSY' ? 'writerbusy' : error.message === 'CAPTURE_PROJECT_MISMATCH' ? 'rejected' : 'unknown', 'ARCHIVE_UNAVAILABLE');
          if (queue.length) record(ticket, 'gap', 'ARCHIVE_INTERRUPTED_QUEUE');
          queue = [];
          bytes = 0;
          // 失败不自动重试，只有新的显式生命周期观察或接管后才可再次尝试，未确认 owner 由其隔离集保留。
          if (owner) { await owner.close(); owner = undefined; }
          break;
        }
      }
    })().catch(() => { faults = true; }).finally(() => { running = undefined; if (queue.length && accepting && !paused) kick(); });
  }
  return {
    async start(ctx) {
      if (!accepting || paused) return;
      const stamp = ++ticket;
      config = null;
      readerCheckout = undefined;
      receipts = [];
      if (!ctx.isProjectTrusted()) return;
      try {
        const selected = await readConfig(ctx.cwd);
        if (stamp !== ticket || !accepting || paused) return;
        config = selected;
        if (config) observe(ctx);
      } catch { record(stamp, 'rejected', 'CONFIG_UNAVAILABLE'); }
    },
    observe,
    async readStatus({ signal } = {}) {
      // 状态观察不得启动 owner，没有当前附着连接时返回 null，而不是伪造已知零。
      const binding = config ? JSON.stringify([config.project, config.cwd, config.privateRoot, config.bunPath]) : null;
      if (!owner || !accepting || paused || ownerBinding !== binding) return null;
      return await exclusive(async combined => {
        const selected = owner;
        const currentBinding = config ? JSON.stringify([config.project, config.cwd, config.privateRoot, config.bunPath]) : null;
        if (!selected || !accepting || paused || ownerBinding !== currentBinding) return null;
        try { return await selected.readStatus({ signal: combined }); }
        catch (error) {
          // owner 只在 status 主动取消且实际关闭已确认后保留原原因，SameValue 比较兼容 NaN 并保留对象身份，不能按错误码或 aborted 单独吞掉真实失败。
          if (combined.aborted && Object.is(error, combined.reason)) return null;
          throw error;
        }
      }, signal);
    },
    async withTaskOwner(ctx, signal, operation) {
      if (!accepting || paused || !config || !ctx.isProjectTrusted()) throw new Error('TASK_DISABLED');
      return await exclusive(async combined => {
        let selected;
        try {
          combined.throwIfAborted();
          if (!accepting || paused || !config) throw new Error('TASK_DISABLED');
          const selectedConfig = config;
          const checkout = await checkoutObserver(ctx.cwd, combined);
          if (checkout.canonicalCwd !== selectedConfig.cwd || !checkout.stable) throw new Error('TASK_STALE');
          const binding = await readTaskBinding(selectedConfig.cwd);
          if (binding && binding.project !== selectedConfig.project) throw new Error('TASK_STALE');
          selected = await ensureOwner(checkout);
          const stamp = ++scopeTicket;
          const expected = JSON.stringify([checkoutBinding(checkout), binding]);
          const isCurrent = () => accepting && !paused && config === selectedConfig && stamp === scopeTicket && owner === selected;
          const scope = { state: 'ready', ticket: stamp, project: selectedConfig.project, worktree: checkout.worktree, isCurrent,
            async verify({ signal: verifySignal } = {}) {
              const cancellation = AbortSignal.any([combined, ...(verifySignal ? [verifySignal] : [])]);
              cancellation.throwIfAborted();
              const latest = await checkoutObserver(selectedConfig.cwd, cancellation);
              const latestBinding = await readTaskBinding(selectedConfig.cwd);
              cancellation.throwIfAborted();
              return isCurrent() && latest.stable && JSON.stringify([checkoutBinding(latest), latestBinding]) === expected;
            } };
          return await operation({ owner: selected, scope, checkoutObservation: { ...checkoutBinding(checkout), generation: binding?.generation ?? null }, publicGeneration: binding?.generation ?? null });
        } catch (error) {
          if (!['TASK_DISABLED', 'TASK_INPUT', 'TASK_SECRET', 'TASK_CAS', 'TASK_CAPACITY', 'TASK_NOT_FOUND', 'TASK_REVISION', 'TASK_UNSELECTED', 'TASK_STALE'].includes(error.message)) {
            faults = true;
            scopeTicket++;
            // preflight 与持久化故障都覆盖既有 owner，不能因失败发生在取得本轮租约之前而漏掉关闭。
            const owned = selected ?? owner;
            if (owned) { await owned.close(); if (owner === owned) owner = undefined; }
          }
          throw error;
        }
      }, signal);
    },
    async synchronizeCheckout() {
      if (!config || paused || !accepting) return false;
      const snapshot = await checkoutObserver(config.cwd, controller.signal);
      if (!snapshot.stable) throw new Error('CHECKOUT_UNSTABLE');
      const next = JSON.stringify(checkoutBinding(snapshot));
      // 首次只建立采集基线，公开 reader 已在自身 preflight 验证，不能因 undefined 基线反复取消初始 index build。
      const changed = readerCheckout !== undefined && readerCheckout !== next;
      if (changed) scopeTicket++;
      readerCheckout = next;
      return changed;
    },
    status() { return Object.freeze({ enabled: config !== null, paused, faulted: faults, receipts: [...receipts] }); },
    async pause() {
      paused = true;
      scopeTicket++;
      controller.abort();
      ticket++;
      queue = [];
      bytes = 0;
      receipts = [{ state: 'gap', reason: 'PAUSED_QUEUE' }];
      await releaseResources();
    },
    close() {
      if (closing) return closing;
      accepting = false;
      paused = true;
      scopeTicket++;
      ticket++;
      queue = [];
      bytes = 0;
      controller.abort();
      // 先推进控制状态与取消，再等待正在建立的 owner，不能在其仍使用 DB 时提前释放。
      closing = releaseResources();
      return closing;
    }
  };
}
