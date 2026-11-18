import { build } from '../validation/worker-http/node_modules/esbuild/lib/main.js';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// 仅维护者显式再生成时读取固定上游，普通分发构建不依赖它，也不修改上游。
const upstream = 'validation/upstream/claude-mem';
const expected = 'f705e9b99601dd9ac03e2f77c5aded6ff3d9471b';
if (execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== expected) {
  throw new Error('UPSTREAM_COMMIT_MISMATCH');
}
await build({
  entryPoints: [`${upstream}/src/services/sqlite/SessionSearch.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['bun:sqlite'],
  outfile: 'src/curated/vendor/session-search.mjs',
  plugins: [{
    name: 'explicit-public-connection-only',
    setup(builder) {
      builder.onResolve({ filter: /\/shared\/paths\.js$/ }, () => ({ path: resolve('src/curated/vendor/search-path-boundary.mjs') }));
      builder.onResolve({ filter: /\/utils\/logger\.js$/ }, () => ({ path: resolve('src/curated/vendor/search-log-boundary.mjs') }));
    }
  }]
});
