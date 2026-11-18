import { validateCheckpointInput } from '../authoring/task-checkpoints.mjs';
import { createTaskContext, snapshotTaskAssociation, removeTaskContext, TASK_MARKER_TYPE } from './task-context.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const expected = new Set(['TASK_INPUT', 'TASK_SECRET', 'TASK_CAS', 'TASK_CAPACITY', 'TASK_NOT_FOUND', 'TASK_REVISION', 'TASK_UNSELECTED', 'TASK_UNAVAILABLE', 'TASK_STALE', 'TASK_BUSY', 'TASK_DISABLED']);
const same = (left, right) => left.state === right.state && left.session === right.session && left.leaf === right.leaf &&
  left.marker?.associationId === right.marker?.associationId && left.marker?.entryId === right.marker?.entryId;
const reply = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });

/** 注册可信任务命令和仅保存当前任务的模型工具，不创建进程、数据库或独立 owner。
 * withTaskOwner(ctx, signal, operation) 必须借用自动采集的同一 writer、串行队列及有界取消，operation 返回前不得释放租约。
 * 租约提供窄 owner、checkoutObservation、publicGeneration 和 scope，scope.verify 必须重新观察 checkout，且 isCurrent 在同步提交前仍有效。
 * isEnabled(ctx) 由可信宿主提供，可异步核实配置，关闭时 context 不访问会话祖先，不能把默认 OFF 解释为允许预读历史。
 * budgetMs 是发起取消的毫秒预算，默认 2000，范围大于 0 且不超过 2000，取消后仍须等待底层有界回收。
 * 工具参数可能由 SDK 保存在原始会话，禁止提交凭据，本模块只向 appendEntry 写 opaque association ID，不复制正文到 details 或公开知识。
 * 发生未分类持久故障后停止本实例的新操作，底层 owner 的实际关闭、unknown 保留与禁止重开由 withTaskOwner 的拥有者负责。
 */
export function installTaskMemory(pi, { withTaskOwner, isEnabled = () => true, budgetMs = 2000 }) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 2000) throw new Error('TASK_BUDGET');
  let closed = false;
  let failed = false;
  let active = null;
  let state = 'unlinked';
  let epoch = 0;
  function report(ctx, value) {
    const content = JSON.stringify(value);
    if (ctx.hasUI) ctx.ui.notify(content, 'info');
    else pi.sendMessage({ customType: 'local-memory-task-status-v1', content, display: true }, { triggerTurn: false });
  }
  async function operation(ctx, signal, work) {
    if (closed || failed || !ctx.isProjectTrusted()) throw new Error('TASK_UNAVAILABLE');
    if (active) throw new Error('TASK_BUSY');
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const ticket = epoch;
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const promise = (async () => {
      try {
        combined.throwIfAborted();
        return await withTaskOwner(ctx, combined, async lease => {
          combined.throwIfAborted();
          if (closed || failed || epoch !== ticket || !lease?.scope?.isCurrent()) throw new Error('TASK_STALE');
          return await work(lease, combined, ticket);
        });
      } catch (error) {
        if (combined.aborted) {
          state = 'unavailable';
          throw new Error('TASK_UNAVAILABLE');
        }
        const code = expected.has(error?.message) ? error.message : 'TASK_UNAVAILABLE';
        if (!expected.has(error?.message)) failed = true;
        state = 'unavailable';
        throw new Error(code);
      } finally {
        clearTimeout(timer);
      }
    })();
    active = { controller, promise };
    try { return await promise; } finally { active = null; }
  }
  function unchanged(ctx, before, lease, signal, ticket) {
    signal.throwIfAborted();
    if (closed || failed || epoch !== ticket || !lease.scope.isCurrent() || !same(before, snapshotTaskAssociation(ctx.sessionManager))) throw new Error('TASK_STALE');
  }
  async function anchor(ctx, before, lease, prepared, signal, ticket) {
    if (!uuid(prepared?.associationId) || !uuid(prepared?.taskId) || !Number.isSafeInteger(prepared.revision) || prepared.revision < 0) throw new Error('TASK_PROTOCOL');
    if (!await lease.scope.verify({ signal })) throw new Error('TASK_STALE');
    unchanged(ctx, before, lease, signal, ticket);
    // 私有 prepare 已提交，此处失败只留下孤立历史，绝不能回退 latest 或把旧 leaf 当成新锚点。
    pi.appendEntry(TASK_MARKER_TYPE, { version: 1, associationId: prepared.associationId });
    const after = snapshotTaskAssociation(ctx.sessionManager);
    if (after.state !== 'associated' || after.session !== before.session || after.marker.associationId !== prepared.associationId) throw new Error('TASK_MARKER');
    await lease.owner.confirmTask({ associationId: prepared.associationId, originSession: after.session, entryId: after.marker.entryId }, { signal });
    state = prepared.revision === 0 ? 'selected-empty' : 'associated';
    return { state, taskId: prepared.taskId, revision: prepared.revision, unreviewed: true };
  }
  async function selected(lease, before, signal) {
    if (before.state !== 'associated') throw new Error('TASK_UNSELECTED');
    const task = await lease.owner.readVisibleTask({ associationId: before.marker.associationId, originSession: before.session, markerEntryId: before.marker.entryId }, { signal });
    if (!task || task.project !== lease.scope.project || task.worktree !== lease.scope.worktree) throw new Error('TASK_UNSELECTED');
    return task;
  }
  pi.registerTool({
    name: 'memory_checkpoint', label: '保存私有任务检查点',
    description: `仅保存可信 memory-task 命令已选中的当前任务，五字段都是来源自述，done 未经核验，不批准、不生成或公开知识。
可信 new 命令创建的空任务使用 revision=0，后续保存必须匹配当前可见版本。
禁止凭据：SDK 可能将工具参数写入原始会话，不能保证完全不留 transcript。
goal 最多1KiB，其他字段各2KiB，完整输入最多8KiB，revision 冲突必须拒绝覆盖。`,
    parameters: { type: 'object', additionalProperties: false,
      properties: { revision: { type: 'integer', minimum: 0 }, goal: { type: 'string' }, constraints: { type: 'string' }, done: { type: 'string' }, next: { type: 'string' }, blockers: { type: 'string' } },
      required: ['revision', 'goal', 'constraints', 'done', 'next', 'blockers'] },
    async execute(_id, args, signal, _onUpdate, ctx) {
      validateCheckpointInput(args);
      return await operation(ctx, signal, async (lease, combined, ticket) => {
        const before = snapshotTaskAssociation(ctx.sessionManager);
        const current = await selected(lease, before, combined);
        if (args.revision !== current.revision) throw new Error('TASK_CAS');
        unchanged(ctx, before, lease, combined, ticket);
        const saved = await lease.owner.saveCheckpoint({ taskId: current.taskId, originSession: before.session, checkoutObservation: lease.checkoutObservation,
          publicGeneration: lease.publicGeneration, declaredBy: 'model', input: args }, { signal: combined });
        return reply(await anchor(ctx, before, lease, saved, combined, ticket));
      });
    }
  });
  pi.registerCommand('memory-task', {
    description: '可信固定任务操作：new、select <UUID> <revision>、resume <UUID> <revision>、status、unlink，不接受文件或通用 SQL。',
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const [command, taskId, revisionText] = parts;
      if (!['new', 'select', 'resume', 'status', 'unlink'].includes(command) ||
          (['select', 'resume'].includes(command) ? parts.length !== 3 || !uuid(taskId) || !/^(0|[1-9][0-9]*)$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText)) : parts.length !== 1)) throw new Error('TASK_INPUT');
      if (command === 'unlink') {
        if (closed || active || !ctx.isProjectTrusted()) throw new Error('TASK_UNAVAILABLE');
        // 解除关联不依赖已失败的私有 owner，但不会清除 failed 或重新打开数据库。
        epoch += 1;
        pi.appendEntry(TASK_MARKER_TYPE, { version: 1, associationId: null });
        state = 'unlinked';
        report(ctx, { state });
        return;
      }
      const result = await operation(ctx, undefined, async (lease, signal, ticket) => {
        const before = snapshotTaskAssociation(ctx.sessionManager);
        if (!['associated', 'unlinked'].includes(before.state)) throw new Error('TASK_STALE');
        if (command === 'status') {
          const totals = await lease.owner.taskStatus({}, { signal });
          const task = before.state === 'associated' ? await lease.owner.readVisibleTask({ associationId: before.marker.associationId, originSession: before.session, markerEntryId: before.marker.entryId }, { signal }) : null;
          if (!await lease.scope.verify({ signal })) throw new Error('TASK_STALE');
          unchanged(ctx, before, lease, signal, ticket);
          return { state: task ? task.revision === 0 ? 'selected-empty' : 'associated' : 'unlinked', taskId: task?.taskId ?? null, revision: task?.revision ?? null, contextState: state, totals };
        }
        const prepared = command === 'new' ? await lease.owner.newTask({ originSession: before.session }, { signal }) :
          await lease.owner.linkTask({ taskId, revision: Number(revisionText), originSession: before.session }, { signal });
        return await anchor(ctx, before, lease, prepared, signal, ticket);
      });
      report(ctx, result);
    }
  });
  pi.on('context', async (event, ctx) => {
    try {
      // 未启用时不读祖先，没有关联时不等待自动归档 owner，维持默认 OFF 与慢后台不阻塞的契约。
      if (!await isEnabled(ctx) || snapshotTaskAssociation(ctx.sessionManager).state !== 'associated') return { messages: removeTaskContext(event.messages) };
      return await operation(ctx, undefined, async (lease, signal) => {
        const reader = createTaskContext({ manager: ctx.sessionManager, reconcileScope: async () => lease.scope,
          readVisibleTask: request => lease.owner.readVisibleTask({ associationId: request.associationId, originSession: request.originSession, markerEntryId: request.markerEntryId }, { signal: request.signal }),
          getContextUsage: () => ctx.getContextUsage(), budgetMs });
        const abort = () => reader.invalidate();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) reader.invalidate();
        try {
          const result = await reader.context(event.messages);
          state = result.state;
          return { messages: result.messages };
        } finally {
          signal.removeEventListener('abort', abort);
          await reader.close();
        }
      });
    } catch {
      // SDK 捕获异常后仍会请求模型，因此失败路径必须返回已移除自有旧注入的消息。
      return { messages: removeTaskContext(event.messages) };
    }
  });
  async function close() {
    closed = true;
    epoch += 1;
    const pending = active;
    pending?.controller.abort();
    if (pending) { try { await pending.promise; } catch { /* 操作已完成失败传播，关闭继续等待真正 settle。 */ } }
    state = 'closed';
  }
  pi.on('session_shutdown', close);
  return Object.freeze({ close, status: () => ({ state, inFlight: active !== null, closed, failed }) });
}
