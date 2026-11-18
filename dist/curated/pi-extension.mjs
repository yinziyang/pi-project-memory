import { createHash } from 'node:crypto';
import { createCurrentReaderRuntime } from './current-reader-runtime.mjs';
import { createTrustedObservationOwner } from './trusted-observation-owner.mjs';
import { createMemoryTools } from './pi-tools.mjs';
import { createAutomaticCapture } from './automatic-capture.mjs';
import { installTaskMemory } from './task-owner.mjs';
import { installDraftCommand } from './draft-command.mjs';
import { createScopeReconciliation } from './scope-reconciliation.mjs';
import { createMemoryStatus } from './memory-status.mjs';
import { startIndexInstall } from './index-init-owner.mjs';
import { recordOwnerFault, flushOwnerDiagnostics } from './owner-diagnostics.mjs';

const quarantineKey = Symbol.for('local-project-memory.curated.unconfirmed.v1');
const quarantine = globalThis[quarantineKey] ??= new Set();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = (code = 'PUBLIC_UNAVAILABLE') => {
  const error = Object.create(Error.prototype);
  Object.defineProperties(error, { message: { value: code }, code: { value: code, enumerable: true } });
  return Object.freeze(error);
};
const publicIdentity = selected => selected && Object.fromEntries(['project', 'scope', 'generation', 'fileIdentity', 'paused', 'stable'].map(key => [key, selected[key]]));
const checkoutToken = value => hash([value.worktree, value.kind, value.commit, value.tree, value.detached, value.unborn, value.dirty, value.dirtyDigest, value.stable]);
const indexPermission = config => config === null ? null : hash(['cwd', 'project', 'cacheRoot', 'modelRoot', 'manifestPath', 'pythonPath', 'bunPath', 'allowCreateCache', 'excludedPaths'].map(key => config[key]));

/** Pi 工厂只注册功能，不在导入阶段读取配置、会话或启动进程。
 * 配置、descriptor/stat 和 checkout 委托有界只读观察子树，writer 与当前 reader 各有独立且明确的实际关闭责任。
 * index 仅由可信 HOME 配置启用，source/checkout/reader epoch 不来自模型，也不随普通 leaf 或 task ticket 改变。
 * SDK appendEntry 的同步会话写入属于 SDK 的资源边界，本插件不能承诺设备永久故障下 SDK 写入可取消。
 * 既有诊断持久写入与 N05 cache namespace I/O 有独立契约，不能把观察隔离扩称为所有依赖文件 I/O 的硬截止。
 */
export default function curatedMemoryExtension(pi) {
  let reader;
  let candidateScope;
  let cachedTools;
  let loadedIdentity;
  let scopeGate;
  let publicPreflight;
  let latestContext;
  let observer;
  let observerStart;
  let observerCwd;
  let observerHome;
  let stopped = false;
  let revision = 0;
  let readerEpoch = 0;
  let grant;
  let queue = Promise.resolve();
  const retirements = new Map();
  let diagnosticEnabled = false;
  let taskMemory;
  let memoryStatus;
  let statusStopped = false;
  let indexInstall;
  let statusPending;
  let statusRequested;
  const statusController = new AbortController();
  const statusReads = new Set();

  async function observation(cwd, method, { signal } = {}) {
    signal?.throwIfAborted();
    if (stopped || !latestContext?.isProjectTrusted() || latestContext.cwd !== cwd) throw unavailable();
    const home = process.env.HOME;
    if (observer && (observerCwd !== cwd || observerHome !== home || observer.diagnostics.closed)) {
      await observer.close();
      observer = undefined;
    }
    if (!observer) {
      observerStart ??= createTrustedObservationOwner({ cwd, home }).then(async owned => {
        if (stopped || latestContext?.cwd !== cwd || process.env.HOME !== home) { await owned.close(); throw unavailable(); }
        observer = owned;
        observerCwd = cwd;
        observerHome = home;
        return owned;
      }).finally(() => { observerStart = undefined; });
      await observerStart;
    }
    signal?.throwIfAborted();
    if (stopped || observerCwd !== cwd || observerHome !== home) throw unavailable();
    return await observer[method]({ signal });
  }
  async function closeObservation() {
    const failures = [];
    if (observerStart) { try { await observerStart; } catch (error) { failures.push(error); } }
    if (observer) { try { await observer.close(); observer = undefined; } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'OBSERVATION_CLOSE_UNCONFIRMED');
  }
  function sourceBinding(ctx, cwd, project) {
    const session = ctx?.sessionManager?.getSessionId();
    if (typeof session !== 'string' || !session || !session.isWellFormed()) throw unavailable('INDEX_BINDING_INVALID');
    return hash([cwd, project, session]);
  }
  function revokeReader() {
    const previous = grant;
    if (previous) readerEpoch++;
    grant = undefined;
    candidateScope = undefined;
    cachedTools = undefined;
    loadedIdentity = undefined;
    // 先同步推进 runtime 撤销/取消，不能等下一次工具调用或诊断输出才停止旧 index build。
    if (previous && reader && !retirements.has(reader)) {
      const owned = reader;
      const pending = owned.transition();
      retirements.set(owned, pending);
      pending.catch(() => { quarantine.add(owned); });
    }
  }
  function queueStatus(ctx = latestContext) {
    if (!ctx || statusStopped) return;
    statusRequested = ctx;
    if (statusPending) return;
    // committed 合并成一个在途刷新和一个待刷新请求，不用 UI 观察挤满串行 owner 队列。
    const pending = (async () => {
      while (statusRequested && !statusStopped) {
        const selected = statusRequested;
        statusRequested = undefined;
        await memoryStatus.refresh(selected, { signal: statusController.signal });
      }
    })().catch(() => { /* 呈现器已返回固定失败状态，非关键 UI 故障不能破坏已提交事务。 */ }).finally(() => {
      statusReads.delete(pending);
      statusPending = undefined;
      if (statusRequested && !statusStopped) queueStatus(statusRequested);
    });
    statusPending = pending;
    statusReads.add(pending);
  }
  const capture = createAutomaticCapture({
    onCommitted: () => { queueStatus(); },
    readConfig: cwd => observation(cwd, 'captureConfig'),
    observe: (cwd, signal) => observation(cwd, 'checkout', { signal }),
    readTaskBinding: async cwd => publicIdentity(await observation(cwd, 'publication')),
    readPublicBinding: cwd => observation(cwd, 'archiveBinding')
  });
  memoryStatus = createMemoryStatus({
    async readStatus({ signal }) {
      const privateStatus = await capture.readStatus({ signal });
      const selected = reader;
      const permission = grant;
      let publication = null;
      let index = null;
      if (selected && permission) {
        try {
          const current = await selected.status({ signal });
          if (reader === selected && grant === permission && permission.epoch === readerEpoch && current.project === permission.project &&
              current.generation === permission.generation && Number.isSafeInteger(current.totalRows) && current.totalRows >= 0) {
            publication = { state: 'known', count: current.totalRows, code: 'OK' };
            // 索引数量只来自当前 READY 的完整验证 records，不能用公开总数或旧缓存数量推导。
            if (current.index?.state === 'READY' && current.index.generation === current.generation && Number.isSafeInteger(current.index.count) && current.index.count >= 0) {
              index = { state: 'ready', count: current.index.count, code: 'OK' };
            } else {
              const phase = { OFF: 'disabled', BUILDING: 'building', INDEX_MISSING: 'missing' }[current.index?.state] ?? 'unavailable';
              index = { state: phase, count: null, code: 'FACT_UNAVAILABLE' };
            }
          }
        } catch { /* 授权或资源不可用时该层保持未知，不拿旧状态或分页长度填零。 */ }
      }
      return { private: privateStatus, publication, index };
    }
  });
  // 旧 reader 直接暴露 bridge 诊断，当前 runtime 将其嵌套在 bridge 下，投影必须取真实桥快照而非把包装对象当桥。
  // 此处只交付桥事实，整个 runtime 是否回收仍由 close/transition 的结果决定，不能用桥 closed 代替索引或任务已停止。
  function bridgeDiagnostics(owned) {
    const diagnostics = owned?.diagnostics;
    return diagnostics?.bridge ?? diagnostics;
  }
  async function closeOwned(owned, operation, stage = 'close') {
    let failure;
    try {
      const results = await Promise.allSettled([...(retirements.has(owned) ? [retirements.get(owned)] : []), owned.close()]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'PUBLIC_CLOSE_UNCONFIRMED');
      quarantine.delete(owned);
    } catch (error) { failure = error; quarantine.add(owned); throw error; }
    finally {
      retirements.delete(owned);
      recordOwnerFault({ operation, stage, error: failure, bridge: bridgeDiagnostics(owned) });
    }
  }

  function lifecycle(ctx, shutdown = false, pauseOnly = false, operation = pauseOnly ? 'pause' : 'refresh') {
    latestContext = ctx;
    revokeReader();
    const retiring = scopeGate;
    retiring?.invalidate();
    scopeGate = undefined;
    const ticket = ++revision;
    if (shutdown) stopped = true;
    let stage = 'close';
    let absent = false;
    const task = queue.then(async () => {
      const failures = [];
      if (retiring) { try { await retiring.close(); } catch (error) { failures.push(error); } }
      if (reader) { try { await closeOwned(reader, operation); reader = undefined; } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'PUBLIC_CLOSE_UNCONFIRMED');
      if (shutdown || pauseOnly || stopped || ticket !== revision) return;
      stage = 'quarantine-close';
      for (const retained of [...quarantine]) await closeOwned(retained, operation, stage);
      stage = 'trust';
      if (!ctx.isProjectTrusted()) throw unavailable('PROJECT_NOT_TRUSTED');
      stage = 'descriptor';
      const selected = await observation(ctx.cwd, 'publication');
      if (!selected) { absent = true; throw unavailable(); }
      diagnosticEnabled = true;
      const indexConfig = await observation(ctx.cwd, 'indexConfig');
      if (indexConfig && (indexConfig.project !== selected.project || indexConfig.cwd !== selected.canonicalCwd)) throw unavailable('INDEX_BINDING_INVALID');
      const configuration = indexPermission(indexConfig);
      if (stopped || ticket !== revision) return;
      const gate = createScopeReconciliation({ cwd: ctx.cwd, project: selected.project, scope: selected.scope,
        observe: (cwd, signal) => observation(cwd, 'checkout', { signal }),
        observePublic: async ({ signal }) => {
          const value = await observation(ctx.cwd, 'publication', { signal });
          if (!value) throw unavailable();
          return publicIdentity(value);
        },
        revokeCandidates: () => { candidateScope = undefined; },
        async loadPublic({ checkout, publication, signal }) {
          signal.throwIfAborted();
          if (stopped || ticket !== revision) throw unavailable();
          const source = indexConfig ? sourceBinding(latestContext, selected.canonicalCwd, selected.project) : null;
          const identity = hash([checkout, publication, configuration, source]);
          if (loadedIdentity === identity && cachedTools && reader) return { tools: cachedTools };
          revokeReader();
          if (reader) { await closeOwned(reader, 'refresh'); reader = undefined; }
          signal.throwIfAborted();
          if (stopped || ticket !== revision) throw unavailable();
          const permission = { project: selected.project, generation: publication.generation, canonicalCwd: selected.canonicalCwd,
            source, checkout: checkoutToken(checkout), fileIdentity: publication.fileIdentity, configuration, epoch: ++readerEpoch };
          grant = permission;
          const owned = createCurrentReaderRuntime({ project: selected.project, cwd: selected.canonicalCwd, bunPath: 'bun', indexConfig,
            async getBinding({ signal: bindingSignal }) {
              if (stopped || ticket !== revision || grant !== permission || readerEpoch !== permission.epoch || !latestContext?.isProjectTrusted()) throw unavailable('INDEX_BINDING_STALE');
              const currentSource = sourceBinding(latestContext, selected.canonicalCwd, selected.project);
              const currentCheckout = await observation(latestContext.cwd, 'checkout', { signal: bindingSignal });
              const currentConfig = await observation(latestContext.cwd, 'indexConfig', { signal: bindingSignal });
              const currentPublic = await observation(latestContext.cwd, 'publication', { signal: bindingSignal });
              bindingSignal.throwIfAborted();
              if (stopped || !latestContext?.isProjectTrusted() || grant !== permission || readerEpoch !== permission.epoch || ticket !== revision ||
                  currentSource !== permission.source || sourceBinding(latestContext, selected.canonicalCwd, selected.project) !== currentSource ||
                  !currentCheckout.stable || currentCheckout.canonicalCwd !== permission.canonicalCwd || checkoutToken(currentCheckout) !== permission.checkout ||
                  indexPermission(currentConfig) !== permission.configuration || !currentPublic || currentPublic.project !== permission.project ||
                  currentPublic.generation !== permission.generation || currentPublic.fileIdentity !== permission.fileIdentity) {
                if (grant === permission) revokeReader();
                throw unavailable('INDEX_BINDING_STALE');
              }
              return { sourceBinding: currentSource, checkoutToken: permission.checkout, ownerEpoch: permission.epoch };
            } });
          reader = owned;
          stage = 'install';
          try {
            await owned.install({ publicPath: selected.publicPath, generation: publication.generation, signal });
            signal.throwIfAborted();
            if (stopped || ticket !== revision || reader !== owned || grant !== permission) throw unavailable();
            cachedTools = createMemoryTools({ reader: owned, project: selected.project, timeoutMs: owned.toolTimeoutMs });
            loadedIdentity = identity;
            return { tools: cachedTools };
          } catch (error) {
            if (grant === permission) revokeReader();
            // scope gate 会将安装失败去敏为不可用，必须先向可信 owner 保存原错，不能等外层只剩 PUBLIC_UNAVAILABLE 时才采样。
            // 诊断入口无 I/O，但快照或记录异常也不得阻断真实关闭，原错、诊断错及关闭错仍由同一失败链保留。
            try { recordOwnerFault({ operation, stage: 'install', error, bridge: bridgeDiagnostics(owned) }); }
            catch (diagnosticError) { error = new AggregateError([error, diagnosticError], 'PUBLIC_INSTALL_REJECTED'); }
            try {
              await closeOwned(owned, operation);
              if (reader === owned) reader = undefined;
            } catch (closeError) { throw new AggregateError([error, closeError], 'PUBLIC_CLOSE_UNCONFIRMED'); }
            throw error;
          }
        } });
      scopeGate = gate;
      const installed = await gate.preflight();
      if (installed.state !== 'ready' || stopped || ticket !== revision || scopeGate !== gate) throw unavailable();
      candidateScope = installed;
    });
    queue = task.catch(() => {});
    return (async () => {
      let failed = false;
      try { await task; } catch (error) {
        failed = true;
        // 全 OFF 且没有公开描述是正常未配置状态，不因此创建 HOME 诊断目录。
        if (!absent) recordOwnerFault({ operation, stage, error, bridge: bridgeDiagnostics(reader) });
      }
      if (!absent && diagnosticEnabled) {
        try { await flushOwnerDiagnostics(operation); } catch {
          if (ticket === revision) {
            revokeReader();
            if (reader) { try { await closeOwned(reader, operation); reader = undefined; } catch { /* 未确认资源已保留。 */ } }
          }
          throw unavailable('PRIVATE_DIAGNOSTIC_WRITE_FAILED');
        }
      }
      if (failed) {
        if (ctx.hasUI) ctx.ui.notify('项目记忆不可用或尚未配置。', 'warning');
        throw unavailable();
      }
    })();
  }
  async function preflightPublic(ctx, signal) {
    signal?.throwIfAborted();
    if (!ctx || stopped || !ctx.isProjectTrusted() || !scopeGate) throw unavailable();
    const gate = scopeGate;
    if (publicPreflight?.gate === gate) {
      const shared = await publicPreflight.promise;
      signal?.throwIfAborted();
      return shared;
    }
    const stamp = revision;
    const holder = { gate };
    // 同周期并发观察合并，不因两个正常工具请求互相撤销而反复取消同一个 index build。
    holder.promise = (async () => {
      const selected = await gate.preflight({ signal });
      if (selected.state !== 'ready' || stopped || stamp !== revision || scopeGate !== gate || !selected.isCurrent()) {
        revokeReader();
        if (reader && scopeGate === gate && selected.state !== 'busy') { await closeOwned(reader, 'refresh'); reader = undefined; }
        throw unavailable();
      }
      let verifying;
      const verify = selected.verify;
      selected.verify = options => {
        verifying ??= verify(options).finally(() => { verifying = undefined; });
        return verifying;
      };
      candidateScope = selected;
      return selected;
    })().finally(() => { if (publicPreflight === holder) publicPreflight = undefined; });
    publicPreflight = holder;
    return await holder.promise;
  }
  const definitions = createMemoryTools({ project: 'uninstalled', reader: {} });
  definitions.forEach((definition, index) => pi.registerTool({
    ...definition,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(id, args, signal, _onUpdate, ctx) {
      const selected = await preflightPublic(ctx ?? latestContext, signal);
      if (candidateScope !== selected || !selected.isCurrent()) throw unavailable();
      const value = await selected.loaded.tools[index].execute(id, args, signal);
      if (!await selected.verify({ signal }) || candidateScope !== selected || !selected.isCurrent()) { revokeReader(); throw unavailable('SOURCE_SCOPE_MISMATCH'); }
      queueStatus(ctx ?? latestContext);
      return value;
    }
  }));
  const memoryToolNames = new Set(definitions.map(definition => definition.name));
  pi.on('context_with_system', async (event, ctx) => {
    let selected;
    if (scopeGate && ctx.cwd === latestContext?.cwd) {
      try { selected = await preflightPublic(ctx, ctx.signal); }
      catch { /* 校验失败只撤下本次请求的记忆工具声明，不阻断其他工具或模型请求。 */ }
    }
    // 请求投影只删不加，宿主的启停、显式工具清单及其他扩展的状态均不由此处改写。
    const ready = !stopped && !ctx.signal?.aborted && ctx.isProjectTrusted() && ctx.cwd === latestContext?.cwd &&
      selected && candidateScope === selected && selected.isCurrent();
    const active = new Set(ready ? pi.getActiveTools() : []);
    const hidden = ({ name }) => memoryToolNames.has(name) && !active.has(name);
    return { messages: event.messages.map(message => {
      if (message.role !== 'system' || (!message.toolsAdded?.some(hidden) && !message.toolsRemoved?.some(hidden))) return message;
      // 支持中途系统消息的 provider 会逐条消费工具补丁，不能只过滤最后合并后的集合。
      const { toolsAdded, toolsRemoved, ...rest } = message;
      const added = toolsAdded?.filter(tool => !hidden(tool));
      const removed = toolsRemoved?.filter(tool => !hidden(tool));
      return { ...rest, ...(added?.length ? { toolsAdded: added } : {}), ...(removed?.length ? { toolsRemoved: removed } : {}) };
    }) };
  });
  taskMemory = installTaskMemory(pi, { withTaskOwner: capture.withTaskOwner,
    async isEnabled(ctx) {
      const state = capture.status();
      if (!state.enabled || state.paused) return false;
      return (await observation(ctx.cwd, 'captureConfig')) !== null;
    } });
  installDraftCommand(pi, { readBinding: ctx => observation(ctx.cwd, 'draftBinding') });
  pi.on('session_start', async (event, ctx) => {
    latestContext = ctx;
    try { await Promise.all([capture.start(ctx), lifecycle(ctx, false, false, event.reason)]); }
    finally { queueStatus(ctx); }
  });
  pi.on('before_agent_start', async (_event, ctx) => {
    let changed;
    try { changed = await capture.synchronizeCheckout(); }
    catch { await lifecycle(ctx, false, true, 'pause'); throw unavailable('CHECKOUT_UNAVAILABLE'); }
    if (changed) await lifecycle(ctx);
  });
  pi.on('agent_settled', (_event, ctx) => { capture.observe(ctx); });
  pi.on('session_tree', (_event, ctx) => { capture.observe(ctx); return lifecycle(ctx, false, false, 'refresh').finally(() => queueStatus(ctx)); });
  pi.on('session_shutdown', async (event, ctx) => {
    statusStopped = true;
    statusRequested = undefined;
    statusController.abort();
    memoryStatus.clear(ctx);
    await taskMemory.close();
    const results = await Promise.allSettled([capture.close(), lifecycle(ctx, true, false, event.reason === 'quit' ? 'shutdown' : event.reason), Promise.allSettled([...statusReads])]);
    try { await indexInstall?.close(); } catch (error) { results.push({ status: 'rejected', reason: error }); }
    try { await closeObservation(); } catch (error) { results.push({ status: 'rejected', reason: error }); }
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw unavailable();
  });
  pi.registerCommand('memory-capture', {
    description: '可信宿主查看自动私有归档状态，或 pause 并实际关闭 writer 后手动接管，不授予生成或发布权限。',
    async handler(args, ctx) {
      if (args.trim() === 'pause') { try { await capture.pause(); } finally { statusRequested = undefined; memoryStatus.clear(ctx); } }
      else if (args.trim() !== '' && args.trim() !== 'status') throw unavailable();
      if (ctx.hasUI) ctx.ui.notify(JSON.stringify(capture.status()), 'info');
    }
  });
  pi.registerCommand('memory-status', {
    description: '只读当前持久状态与已核验公开/index总量，不为查询启动 writer，不用分页长度猜测总数。',
    async handler(args, ctx) {
      if (args.trim() || statusStopped) throw unavailable();
      const result = await memoryStatus.refresh(ctx, { signal: statusController.signal });
      let installation = { state: 'unknown', e5: 'unknown', chroma: 'unknown' };
      if (ctx.isProjectTrusted()) {
        try { installation = await observation(ctx.cwd, 'indexInstallation', { signal: statusController.signal }); }
        catch { /* 安装状态读取失败不改写已经核验的公开计数。 */ }
      }
      const route = result.snapshot.index.state === 'ready' ? '向量索引就绪' : result.snapshot.publication.state === 'known' ? '向量未就绪，可尝试 SQLite；损坏索引仍报错' : '公开知识不可用';
      const content = `${result.text}\n用户级安装：${installation.state}；E5 文件=${installation.e5}；Chroma 包=${installation.chroma}；${route}。`;
      pi.sendMessage({ customType: 'local-project-memory.status-output.v1', content, display: true, details: { code: result.code, snapshot: result.snapshot, installation } }, { triggerTurn: false });
    }
  });
  pi.registerCommand('memory-init', {
    description: '显式安装当前用户的本地 E5 和 Chroma，之后为可信且已发布的项目默认开启语义搜索。',
    async handler(args, ctx) {
      if (args.trim() || stopped || !ctx.isProjectTrusted()) throw unavailable('INDEX_INSTALL_NOT_ALLOWED');
      if (indexInstall) throw unavailable('INDEX_INSTALL_BUSY');
      const selected = startIndexInstall(process.env.HOME);
      indexInstall = selected;
      const code = await selected.result;
      if (code !== 'INDEX_INSTALL_CLOSE_UNCONFIRMED') indexInstall = undefined;
      if (code !== 'INDEX_INSTALL_READY') throw unavailable(code);
      if (stopped) return;
      if (latestContext?.cwd === ctx.cwd && ctx.isProjectTrusted() && await observation(ctx.cwd, 'publication')) await lifecycle(ctx);
      if (ctx.hasUI) ctx.ui.notify('E5 与 Chroma 安装已核验，可信且有效发布的项目默认启用语义搜索。', 'info');
    }
  });
  pi.registerCommand('memory-refresh', {
    description: '可信宿主刷新当前公开版本和显式配置，pause 先实际停读，index 显式修复当前 matching 索引，不提炼、审核或下载模型。',
    async handler(args, ctx) {
      const action = args.trim();
      if (action === 'index') {
        const selected = reader;
        const permission = grant;
        if (!selected || !permission || stopped || !ctx.isProjectTrusted()) throw unavailable();
        try {
          await selected.refreshIndex({ signal: statusController.signal });
          if (selected !== reader || permission !== grant) throw unavailable();
        } catch (error) {
          recordOwnerFault({ operation: 'refresh', stage: 'install', error });
          throw unavailable();
        }
        queueStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify('当前索引已显式重新核验并构建。', 'info');
        return;
      }
      if (action !== '' && action !== 'pause') throw unavailable();
      try { await lifecycle(ctx, false, action === 'pause'); }
      finally { if (action === 'pause') { statusRequested = undefined; memoryStatus.clear(ctx); } else queueStatus(ctx); }
      if (ctx.hasUI) ctx.ui.notify(action === 'pause' ? '项目记忆已停服并回收。' : '项目公开记忆已重新安装。', 'info');
    }
  });
}
