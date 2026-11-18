/** 限制单次 SDK 生成的实际响应字节，先有限收齐 wire 再交 SDK，避免其内部先无限累计。
 * 只允许选定 origin 且禁止重定向，实际 body 限 4MiB，取消时先 abort 自有请求再最多等待 1 秒释放 reader。
 * 生成只允许一次 fetch，不重试或补发，认证刷新由 SDK 正常接口负责，不读取认证文件。
 */
export function boundedSdkFetch({ signal, expectedOrigin, fetchImpl = fetch, limit = 4 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4 * 1024 * 1024) {
    throw new Error("SDK_WIRE_BUDGET");
  }
  let calls = 0;
  let responseComplete = false;
  const bounded = async (url, init = {}) => {
    if (++calls !== 1) {
      throw new Error("SDK_MULTIPLE_FETCHES");
    }
    const target = new URL(typeof url === "string" ? url : url.url ?? url);
    if (target.origin !== expectedOrigin || target.username || target.password) {
      throw new Error("SDK_UNEXPECTED_ORIGIN");
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let reader, completed = false;
    const cancel = () => {
      controller.abort();
      if (reader) {
        reader.cancel().catch(() => {});
      }
    };
    combined.addEventListener("abort", cancel, { once: true });
    try {
      combined.throwIfAborted();
      const response = await fetchImpl(url, { ...init, signal: combined, redirect: "error" });
      if (!response.ok || !response.body) {
        throw new Error("SDK_HTTP_REFUSED");
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
        throw new Error("SDK_WIRE_LIMIT");
      }
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (; ; ) {
        combined.throwIfAborted();
        const { done, value } = await reader.read();
        combined.throwIfAborted();
        if (done) {
          completed = true;
          responseComplete = true;
          break;
        }
        if (value.byteLength > limit - total) {
          throw new Error("SDK_WIRE_LIMIT");
        }
        total += value.byteLength;
        chunks.push(value);
      }
      const raw = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // fetch 已处理压缩，原 Content-Length 不代表解压后的 body，SDK 只消费实际有限字节。
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(raw, { status: response.status, statusText: response.statusText, headers });
    } finally {
      combined.removeEventListener("abort", cancel);
      if (!completed) {
        controller.abort();
      }
      if (reader) {
        let timer;
        try {
          if (!completed) {
            await Promise.race([
              reader.cancel().catch(() => {}),
              new Promise((resolve) => {
                timer = setTimeout(resolve, 1000);
              }),
            ]);
          }
        } finally {
          clearTimeout(timer);
          reader.releaseLock();
        }
      }
    }
  };
  return Object.defineProperties(bounded, {
    calls: {get: () => calls},
    responseComplete: {get: () => responseComplete},
  });
}
