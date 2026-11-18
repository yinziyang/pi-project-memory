import {build} from '../validation/worker-http/node_modules/esbuild/lib/main.js';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

// 仅维护者再生成读取只读固定检出，普通构建与运行不依赖上游目录。
const upstream='validation/upstream/claude-mem';
const expected='f705e9b99601dd9ac03e2f77c5aded6ff3d9471b';
if(execFileSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==expected)throw new Error('UPSTREAM_COMMIT_MISMATCH');
await build({
  entryPoints:[`${upstream}/src/services/sqlite/SessionStore.ts`],
  bundle:true,platform:'node',format:'esm',external:['bun:sqlite'],
  outfile:'src/authoring/vendor/session-store.mjs',
  plugins:[{name:'explicit-private-connection-only',setup(builder){
    builder.onResolve({filter:/\/shared\/paths\.js$/},()=>({path:resolve('src/authoring/vendor/store-path-boundary.mjs')}));
    builder.onResolve({filter:/(^|\/)logger\.js$/},()=>({path:resolve('src/authoring/vendor/store-log-boundary.mjs')}));
    builder.onResolve({filter:/\/shared\/SettingsDefaultsManager\.js$/},()=>({path:resolve('src/authoring/vendor/store-settings-boundary.mjs')}));
  }}],
});
