// 依赖仅写固定 JSON 事件，不记录原始消息或异常，stderr 故障由写宿主入口统一收尾。
function warning() {process.stderr.write('{"kind":"STORE_DIAGNOSTIC"}\n');}
export const logger=Object.freeze({debug(){},info(){},warn:warning,error:warning});
