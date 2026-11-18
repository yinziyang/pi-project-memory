import { cp, mkdir, rm } from 'node:fs/promises';

// 分发构建只复制自包含运行时，不读取 validation、用户配置或固定上游检出。
// 先清除旧 curated 产物，避免撤出的运行时代码被残留并打入分发包。
const source = new URL('../src/curated/', import.meta.url);
const target = new URL('../dist/curated/', import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
// 写宿主与只读插件分入口，消费者构建仅复制已隔离的正式源码。
const authoringSource=new URL('../src/authoring/',import.meta.url);
const authoringTarget=new URL('../dist/authoring/',import.meta.url);
await rm(authoringTarget,{recursive:true,force:true});
await mkdir(authoringTarget,{recursive:true});
await cp(authoringSource,authoringTarget,{recursive:true});
