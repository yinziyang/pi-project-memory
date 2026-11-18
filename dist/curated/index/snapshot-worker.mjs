import { Database } from 'bun:sqlite';
import { readCurrentCuration } from '../current-curation.mjs';
import { createInterface } from 'node:readline';

// 独占只读事务覆盖完整校验与分批导出，父进程必须等待 EOF 和实际 close 后才可替换公开库。
let db;
let snapshot;
let cursor = 0;
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const message = JSON.parse(line);
    let result;
    if (message.op === 'init' && !db) {
      db = new Database(message.publicPath, { readonly: true, strict: true });
      db.exec('PRAGMA query_only=ON; BEGIN');
      snapshot = readCurrentCuration(db, { project: message.project });
      result = { generation: snapshot.generation, count: snapshot.rows.length };
    } else if (message.op === 'next' && snapshot && message.offset === cursor && cursor < snapshot.rows.length) {
      const rows = snapshot.rows.slice(cursor, cursor + 4);
      result = { offset: cursor, rows };
      cursor += rows.length;
    } else throw new Error('INDEX_PROTOCOL_INVALID');
    await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`, (error) => error ? reject(error) : resolve()));
  }
  if (db) db.exec('COMMIT');
} catch {
  console.log(JSON.stringify({ ok: false, code: 'INDEX_PUBLICATION_INVALID' }));
  process.exitCode = 1;
} finally {
  db?.close();
}
