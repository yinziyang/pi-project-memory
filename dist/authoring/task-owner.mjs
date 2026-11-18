import { initializeTaskCheckpoints } from './task-checkpoints.mjs';

/** 为 assistant-local host 提供固定 task IPC 能力，借用唯一 LocalWriter，不创建 transport、consumer 或第二个数据库 owner。
 * host 负责帧白名单、串行执行和错误后的真实收尾，任意持久化异常必须传播，不在本层包装成成功或自动重试。
 * 可信命令选择 task，模型只经宿主已选关联提交五字段和 revision，不能获得本对象的通用 RPC。
 */
export function initializeTaskOwner(writer, options) {
  const store = initializeTaskCheckpoints(writer.db, options);
  return Object.freeze({
    newTask({ originSession }) { return store.createTask(originSession); },
    saveCheckpoint(request) { return store.prepareCheckpoint(request); },
    linkTask(request) { return store.prepareAssociation(request); },
    readVisibleTask({ associationId, originSession, markerEntryId }) {
      const task = store.readAssociation({ associationId, originSession });
      // 只有宿主核实实际祖先 marker 后才能提供 markerEntryId，不能拿任意 leaf 补确认。
      if (task && markerEntryId !== undefined) store.confirmAssociation({ associationId, originSession, entryId: markerEntryId });
      return task;
    },
    confirmTask(request) { return store.confirmAssociation(request); },
    taskStatus() { return store.status(); }
  });
}
