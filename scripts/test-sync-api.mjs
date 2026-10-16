// Explicitly local-only: never run contract writes against the deployed website.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const endpoint = new URL(process.env.READER_TEST_ENDPOINT || 'http://127.0.0.1:5181/api/index.php');
if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('API 联调测试只允许本机隔离环境');
const key = randomBytes(32).toString('hex'), secondKey = randomBytes(32).toString('hex');
const version = 'a'.repeat(64), book = `epub:${version}`;
const point = chapter => ({ version, chapter, block: 0, fraction: .5, percent: 20, updatedAt: Date.now() });
async function call(action, data = {}, token = key, origin = 'https://novel.fuhao574.cyou') {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: origin },
    body: JSON.stringify({ action, ...data }),
  });
  return { status: response.status, body: await response.json() };
}
try {
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await call('create', {}, key, 'https://untrusted.example')).status, 403);
  assert.equal((await call('connect', {}, 'bad')).status, 401);
  assert.equal((await call('connect')).status, 401);
  assert.equal((await call('create')).status, 200);
  assert.equal((await call('connect')).status, 200);
  assert.equal((await call('get', { book })).body.record.revision, 0);
  const first = await call('put', { book, revision: 0, progress: { ...point(3), content: 'must not persist' } });
  assert.equal(first.status, 200); assert.equal(first.body.record.revision, 1);
  assert.equal(first.body.record.progress.content, undefined);
  const conflict = await call('put', { book, revision: 0, progress: point(4) });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.record.progress.chapter, 3);
  // Two devices racing from the same revision: exactly one succeeds.
  const raced = await Promise.all([5, 6].map(chapter => call('put', { book, revision: 1, progress: point(chapter) })));
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 409]);
  assert.equal((await call('get', { book })).body.record.revision, 2);
  assert.equal((await call('put', { book, revision: 2, progress: { ...point(7), block: -1 } })).status, 400);
  assert.equal((await call('get', { book: '../secret' })).status, 400);
  assert.equal((await call('create', {}, secondKey)).status, 200);
  assert.equal((await call('get', { book }, secondKey)).body.record.progress, null);
  assert.equal((await call('erase')).status, 200);
  assert.equal((await call('connect')).status, 401);
  assert.equal((await call('create')).status, 401);
  assert.equal((await call('erase', {}, secondKey)).status, 200);
  console.log('PHP + MySQL 本机接口联调通过：鉴权、来源校验、读写、版本冲突、并发写入、用户隔离、删除与密钥作废');
} finally {
  // Only random test identities in this isolated local database.
  await call('erase').catch(() => {});
  await call('erase', {}, secondKey).catch(() => {});
}
