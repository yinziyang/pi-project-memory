/** 随包检索器只能借用调用方已打开的公开连接，禁止默认路径创建或查找用户工作库。 */
export const DATA_DIR = '';
export const DB_PATH = '';
export function ensurePrivateDir() {
  throw new Error('EXPLICIT_PUBLIC_CONNECTION_REQUIRED');
}
