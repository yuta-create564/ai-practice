// Edge Function(ChatGPT用の窓口)を、ローカルの本物の Postgres につないでテストする。
// 実行: PGHOST=... PGPORT=... sh tests/sql/run.sh && node --experimental-strip-types --test tests/edge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { handle } from '../supabase/functions/eigo-api/index.ts';

const psql = (sql) => execFileSync('psql', ['-U', 'postgres', '-d', 'eigo_test', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql }).toString().trim();
const KEY = 'eigo_' + 'K'.repeat(20) + 'k'.repeat(20);
const hash = createHash('sha256').update(KEY).digest('hex');
psql(`insert into public.api_keys (user_id, key_hash, label) values ('aaaaaaaa-0000-4000-8000-000000000001', '${hash}', 'test') on conflict do nothing;`);

const SERVICE_KEY = 'service-role-test-key';
let lastHeaders = null;
// PostgREST の代わり: /rest/v1/rpc/<関数名> を psql で service_role として実行する
async function fakeRest(url, init) {
  lastHeaders = init.headers;
  assert.equal(init.headers.apikey, SERVICE_KEY);
  const fn = url.split('/rpc/')[1];
  const args = JSON.parse(init.body);
  const lit = (v) => (v == null ? 'null' : "'" + String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/'/g, "''") + "'");
  const call = fn === 'eigo_api_add'
    ? `public.eigo_api_add(${lit(args.p_key_hash)}, ${lit(args.p_request_id)}, ${lit(args.p_items)}::jsonb)`
    : `public.eigo_api_search(${lit(args.p_key_hash)}, ${lit(args.p_query)}, ${Number(args.p_limit)})`;
  const out = psql(`set role service_role; select ${call}::text;`);
  return new Response(out, { status: 200 });
}
const env = { url: 'http://db.local', serviceKey: SERVICE_KEY };
const call = (method, path, { key = KEY, body, headers = {} } = {}) =>
  handle(new Request('https://x.supabase.co/functions/v1/eigo-api' + path, {
    method, headers: Object.assign(key ? { Authorization: 'Bearer ' + key } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers),
    body: body ? JSON.stringify(body) : undefined,
  }), env, fakeRest);

test('キーなし・形式違いのキーは 401', async () => {
  assert.equal((await call('GET', '/ping', { key: null })).status, 401);
  assert.equal((await call('GET', '/ping', { key: 'abc' })).status, 401);
});
test('登録されていないキーは 401', async () => {
  assert.equal((await call('GET', '/ping', { key: 'eigo_' + 'Z'.repeat(40) })).status, 401);
});
test('正しいキーで接続確認できる', async () => {
  const r = await call('GET', '/ping');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});
test('登録・重複除外・再送で二重にならない', async () => {
  const body = { request_id: 'gpt-req-1', items: [
    { type: 'word', en: 'reluctant', ja: '気が進まない', example: 'He was "reluctant"\nto go.' },
    { type: 'sentence', en: 'Could you say that again?', ja: 'もう一度' },
  ] };
  const r1 = await (await call('POST', '/items', { body })).json();
  assert.equal(r1.added.length, 1);
  assert.equal(r1.duplicates.length, 1, '既にある英文は重複として返る');
  const r2 = await (await call('POST', '/items', { body })).json();
  assert.equal(r2.replayed, true, '同じ request_id は再送扱い');
  const r3 = await (await call('POST', '/items', { body: { items: body.items }, headers: { 'Idempotency-Key': 'other' } })).json();
  assert.equal(r3.added.length, 0, 'request_id が違っても同じ内容は追加しない');
  assert.equal(psql("select count(*) from public.items where en = 'reluctant'"), '1');
  assert.equal(psql("select example from public.items where en = 'reluctant'"), 'He was "reluctant"\nto go.');
});
test('他人のデータは検索に出ない・自分のデータは出る', async () => {
  psql(`insert into public.items (id, user_id, kind, en, ja, created_at_ms, updated_at_ms) values (gen_random_uuid(), 'bbbbbbbb-0000-4000-8000-000000000002', 'word', 'reluctantly-b', 'B', 1, 1);`);
  const r = await (await call('GET', '/items?q=reluctant')).json();
  assert.deepEqual(r.items.map((x) => x.en), ['reluctant']);
});
test('入力の誤りはわかりやすく返す', async () => {
  assert.equal((await call('POST', '/items', { body: { items: [] } })).status, 400);
  const tooMany = { items: Array.from({ length: 51 }, (_, i) => ({ type: 'word', en: 'w' + i, ja: 'x' })) };
  assert.equal((await call('POST', '/items', { body: tooMany })).status, 400);
  const r = await (await call('POST', '/items', { body: { items: [{ type: 'idiom', en: 'x', ja: 'y' }, { type: 'word', en: 'only-en' }] } })).json();
  assert.equal(r.errors.length, 2);
  const bad = await handle(new Request('https://x/functions/v1/eigo-api/items', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: '{' }), env, fakeRest);
  assert.equal(bad.status, 400);
});
test('保存先に接続できないときは 502 で、登録済みかの確認方法を伝える', async () => {
  const down = async () => { throw new Error('down'); };
  const r = await handle(new Request('https://x/functions/v1/eigo-api/items', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: '{"items":[{"type":"word","en":"a","ja":"b"}]}' }), env, down);
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /一覧で確認/);
});
test('新形式の秘密キー(sb_secret_)では Authorization ヘッダーを付けない', async () => {
  await handle(new Request('https://x/functions/v1/eigo-api/ping', { headers: { Authorization: 'Bearer ' + KEY } }), { url: 'http://db', serviceKey: 'sb_secret_x' }, async (u, init) => { lastHeaders = init.headers; return new Response('{"items":[]}'); });
  assert.equal(lastHeaders.Authorization, undefined);
  assert.equal(lastHeaders.apikey, 'sb_secret_x');
});
