import { mkdirSync, lstatSync, readdirSync, chmodSync, openSync, closeSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute } from "node:path";
const FILES = new Set(["private.sqlite", "private.sqlite-wal", "private.sqlite-shm", "private.sqlite.owner", "private.sqlite.owner-journal"]);
/** 创建或验证仅当前 UID 可访问的私有目录，不接管既存链接、未知文件或开放权限，不修改进程 umask。
 * 调用方提供可信父目录并保证独占，不防御同 UID 恶意并发替换祖先路径。
 */
export function privateDirectory(path) {
  if (typeof path !== "string" || !path || !path.isWellFormed() || path.includes("\0") || resolve(path) !== path) {
    throw new Error("PRIVATE_DIRECTORY_INVALID");
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  const root = lstatSync(path);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700) {
    throw new Error("PRIVATE_DIRECTORY_UNSAFE");
  }
  for (const name of readdirSync(path)) {
    if (!FILES.has(name)) {
      throw new Error("PRIVATE_DIRECTORY_UNKNOWN_FILE");
    }
    const item = lstatSync(join(path, name));
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.uid !== process.getuid() || (item.mode & 0o077) !== 0) {
      throw new Error("PRIVATE_FILE_UNSAFE");
    }
  }
  // SQLite 新 sidecar 继承主库权限，owner 文件预建为 0600，不依赖借用的进程全局 umask。
  const owner = join(path, "private.sqlite.owner");
  try {
    const fd = openSync(owner, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  return join(path, "private.sqlite");
}
/** 仅收紧本宿主已创建的已知文件，不能用于接管既存不安全目录。 */
export function secureOwnedFiles(path) {
  for (const name of readdirSync(path)) {
    if (!FILES.has(name)) {
      throw new Error("PRIVATE_DIRECTORY_UNKNOWN_FILE");
    }
    const target = join(path, name), item = lstatSync(target);
    if (!item.isFile() || item.isSymbolicLink() || item.uid !== process.getuid() || item.nlink !== 1) {
      throw new Error("PRIVATE_FILE_UNSAFE");
    }
    chmodSync(target, 0o600);
  }
}

// 私有根可能尚未创建，只解析已有祖先，不通过 mkdir 或字符串前缀猜测物理关系。
function prospectiveRealPath(path) {
  if (typeof path !== 'string' || !path || !path.isWellFormed() || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('PRIVATE_DIRECTORY_INVALID');
  }
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(current) === current) {
        throw error;
      }
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}

/** 只读校验私有与项目根的真实路径，双向祖先关系均拒绝，必须在创建任何宿主资源之前调用。
 * 私有库不能位于项目、公开目录、stage 或 retained 内，项目也不能放入严格私有根导致扫描与权限自污染。
 * 调用方仍须保证可信独占祖先，不防御校验后的同 UID 恶意替换。
 */
export function assertSeparatedDirectories(privatePath, projectPath) {
  if (typeof projectPath !== 'string' || !projectPath || !projectPath.isWellFormed() || projectPath.includes('\0') || !isAbsolute(projectPath)) {
    throw new Error('PUBLIC_PROJECT_PATH');
  }
  const privateRoot = prospectiveRealPath(privatePath);
  const projectRoot = realpathSync(projectPath);
  if (!lstatSync(projectRoot).isDirectory()) {
    throw new Error('PUBLIC_PROJECT_PATH');
  }
  for (const [parent, child] of [[privateRoot, projectRoot], [projectRoot, privateRoot]]) {
    const path = relative(parent, child);
    if (path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path))) {
      throw new Error('PRIVATE_PUBLIC_OVERLAP');
    }
  }
}

/** standalone 发布与恢复也从借用连接的实际主库路径校验边界，不依赖 CLI 已校验或调用方口头声明。 */
export function assertPublicationSeparation(db, projectPath) {
  const main = db.query('PRAGMA database_list').get();
  if (!main || typeof main.file !== 'string' || !main.file) {
    throw new Error('PRIVATE_DATABASE_PATH_REQUIRED');
  }
  assertSeparatedDirectories(dirname(main.file), projectPath);
}
