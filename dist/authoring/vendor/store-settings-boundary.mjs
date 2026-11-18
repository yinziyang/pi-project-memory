/** 显式私有宿主固定禁用模糊去重，不读取 HOME、环境或 settings 文件。 */
export class SettingsDefaultsManager {
  static loadFromFile() {return {CLAUDE_MEM_DEDUP_ENABLED:'false'};}
}
