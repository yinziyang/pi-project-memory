/** 写宿主只能使用显式连接，不发现用户路径或配置。 */
export const DATA_DIR = '';
export const DB_PATH = '';
export const USER_SETTINGS_PATH = '';
export const OBSERVER_SESSIONS_PROJECT = '__local_memory_observer__';
export function ensurePrivateDir() {throw new Error('EXPLICIT_AUTHORING_CONNECTION_REQUIRED');}
