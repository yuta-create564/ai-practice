// 画面の動作テスト(Chromium)。 実行: node --test tests/e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'sentence-app');
const shots = process.env.SHOTS || join(here, '..', 'test-results');
mkdirSync(shots, { recursive: true });
const PORT = 8765;
const BASE = `http://localhost:${PORT}/`;
const SE = { width: 375, height: 667 }; // iPhone SE(第2・第3世代)
const SE1 = { width: 320, height: 568 }; // iPhone SE(第1世代)

let server, browser;
test.before(async () => {
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: appDir, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();
});
test.after(async () => { await browser.close(); server.kill(); });

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || SE, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  if (opts.fake) {
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: readFileSync(join(here, 'fake-supabase.js'), 'utf8') }));
    await page.exposeFunction('fakeServer', (q) => JSON.stringify(opts.fake.handle(JSON.parse(q))));
  }
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(opts.url || BASE);
  return { ctx, page, errors };
}
const tab = (page, name) => page.click(`nav.tabs button[data-view="${name}"]`);
const items = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('eigo-app:items')));
async function noSideScroll(page, label) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(w[0] <= w[1], `${label}: 横スクロールが出ている (${w[0]} > ${w[1]})`);
}
async function addItem(page, { kind = 'sentence', en, ja, example = '', note = '' }) {
  await tab(page, 'add');
  await page.click(`#form-kind button[data-value="${kind}"]`);
  await page.fill('#f-en', en); await page.fill('#f-ja', ja);
  await page.fill('#f-example', example); await page.fill('#f-note', note);
  await page.click('#f-submit');
}

test('1. 旧データの引き継ぎ(消さずに新形式へ)', async () => {
  const legacy = JSON.stringify([{ id: 'old1', en: "I'm looking forward to it.", ja: 'それを楽しみにしています。', createdAt: 1 }, { id: 'old2', en: 'See you later.', ja: 'またね。', createdAt: 2 }]);
  const { ctx, page, errors } = await open({ init: `if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sentence-app:cards', ${JSON.stringify(legacy)}); localStorage.setItem('sentence-app:direction', 'en2ja'); sessionStorage.setItem('seeded', '1'); }` });
  assert.ok(await page.isVisible('#migrated-notice'));
  const list = await items(page);
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.kind === 'sentence' && x.status === 'learning'));
  assert.equal(await page.evaluate(() => localStorage.getItem('sentence-app:cards')) !== null, true, '旧データは残っている');
  assert.ok(await page.evaluate(() => localStorage.getItem('eigo-app:legacy-backup')), '引き継ぐ前の控えがある');
  assert.equal(await page.locator('#settings-summary').textContent().then((t) => t.startsWith('英→日')), true, '前の出題方向を引き継ぐ');
  await page.screenshot({ path: join(shots, 'migrated.png') });
  await page.reload();
  assert.equal((await items(page)).length, 2, '再読み込みしても2回引き継がない');
  assert.equal(await page.isVisible('#migrated-notice'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('2〜3. 登録・重複・練習(方向・対象・覚えた/まだ・順番)・一覧・検索・編集・削除・再読み込み', async () => {
  const { ctx, page, errors } = await open();
  await addItem(page, { kind: 'word', en: 'postpone', ja: '延期する', example: "Let's postpone it.", note: 'put off と同じ' });
  await addItem(page, { kind: 'sentence', en: 'See you later.', ja: 'またね。' });
  await addItem(page, { kind: 'sentence', en: 'Thank you so much.', ja: '本当にありがとう。' });
  assert.equal((await items(page)).length, 3);
  // 重複
  await addItem(page, { kind: 'word', en: 'Postpone', ja: '延ばす' });
  assert.ok(await page.isVisible('#dup-warning'), '重複の警告が出る');
  assert.equal((await items(page)).length, 3, '重複はそのままでは登録されない');
  await page.screenshot({ path: join(shots, 'duplicate.png') });
  await page.click('#dup-force');
  assert.equal((await items(page)).length, 4, '「それでも追加」で登録できる');

  // 練習: 日→英(既定)・登録順・単語のみ
  await tab(page, 'practice');
  await page.click('#practice-settings summary');
  await page.click('[data-setting="order"] [data-value="ordered"]');
  await page.click('[data-setting="target"] [data-value="word"]');
  assert.equal(await page.textContent('#card-q'), '延期する', '日本語が問題として出る');
  await page.click('#card');
  assert.equal(await page.textContent('#card-a'), 'postpone', 'タップで英語の答え');
  assert.match(await page.textContent('.answer'), /Let's postpone it\./, '例文も出る');
  await page.screenshot({ path: join(shots, 'practice-answer.png') });
  await page.click('#mark-learned');
  assert.equal((await items(page)).find((x) => x.en === 'postpone').status, 'learned');
  // まだのものだけ → 覚えた単語は出ない
  await page.click('[data-setting="scope"] [data-value="learning"]');
  assert.equal(await page.textContent('#card-q'), '延ばす');
  // 英→日
  await page.click('[data-setting="direction"] [data-value="en2ja"]');
  assert.equal(await page.textContent('#card-q'), 'Postpone');
  await page.click('#reveal');
  assert.equal(await page.textContent('#card-a'), '延ばす');
  await page.click('#mark-learning');
  // センテンスのみ・全部
  await page.click('[data-setting="target"] [data-value="sentence"]');
  await page.click('[data-setting="scope"] [data-value="all"]');
  assert.equal(await page.textContent('#card-q'), 'See you later.');
  // 両方・ランダム
  await page.click('[data-setting="target"] [data-value="all"]');
  await page.click('[data-setting="order"] [data-value="random"]');
  assert.match(await page.textContent('.card .count'), /1 \/ 4/);
  await noSideScroll(page, '練習');

  // 一覧: 検索・覚えた→まだに戻す・編集・削除
  await tab(page, 'list');
  await page.fill('#list-q', '延期');
  assert.equal(await page.locator('#list li').count(), 1);
  await page.click('#list li button[data-act="status"]');
  assert.equal((await items(page)).find((x) => x.en === 'postpone').status, 'learning', '「まだ」に戻せる');
  await page.fill('#list-q', '');
  await page.click('#list-status [data-value="learning"]');
  assert.equal(await page.locator('#list li').count(), 4);
  await page.click('#list-status [data-value="all"]');
  await page.click('#list-kind [data-value="word"]');
  assert.equal(await page.locator('#list li').count(), 2);
  await page.click('#list-kind [data-value="all"]');
  // 編集
  await page.locator('#list li', { hasText: 'Thank you so much.' }).locator('button[data-act="edit"]').click();
  assert.equal(await page.inputValue('#f-en'), 'Thank you so much.');
  await page.fill('#f-ja', 'どうもありがとう。');
  await page.click('#f-submit');
  assert.equal((await items(page)).find((x) => x.en === 'Thank you so much.').ja, 'どうもありがとう。');
  // 削除(2回押す)
  const del = page.locator('#list li', { hasText: 'See you later.' }).locator('button[data-act="delete"]');
  await del.click();
  assert.equal(await del.textContent(), 'もう一度押すと削除');
  await del.click();
  assert.equal(await page.locator('#list li', { hasText: 'See you later.' }).count(), 0);
  await page.screenshot({ path: join(shots, 'list.png') });
  await noSideScroll(page, '一覧');

  // 再読み込み後も残る
  await page.reload();
  await tab(page, 'list');
  assert.equal(await page.locator('#list li').count(), 3);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('eigo-app:settings')));
  assert.equal(st.direction, 'en2ja', '出題設定も残る');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('4. まとめて登録(形式の誤り・必須不足・重複・選択・修正・追加のみ)', async () => {
  const { ctx, page, errors } = await open();
  await addItem(page, { kind: 'word', en: 'postpone', ja: '延期する' });
  await tab(page, 'bulk');
  // 形式の誤り
  await page.fill('#bulk-text', '{"items": [\n {"type":"word","en":"a","ja":"b"}\n {"type":"word"}]}');
  await page.click('#bulk-parse');
  assert.ok(await page.isVisible('#bulk-error'));
  assert.match(await page.textContent('#bulk-error'), /3行目/);
  await page.screenshot({ path: join(shots, 'bulk-error.png') });
  // ChatGPTの回答そのまま(前置き・コードブロック・改行・記号を含む)
  const answer = 'もちろんです!\n```json\n' + JSON.stringify({ items: [
    { type: 'word', en: 'Postpone', ja: '延期する' },
    { type: 'word', en: 'reluctant', ja: '気が進まない', example: 'She was "reluctant"\nto leave.' },
    { type: 'sentence', en: 'Could you say that again?', ja: '' },
    { type: 'sentence', en: "I'm on my way.", ja: '今向かっています。', note: 'on my way = 途中' },
    { type: 'sentence', en: "I'm on my way", ja: '向かってます' },
  ] }, null, 2) + '\n```\n他にも必要なら言ってください。';
  await page.fill('#bulk-text', answer);
  await page.click('#bulk-parse');
  assert.ok(await page.isVisible('#bulk-preview-panel'));
  const checks = page.locator('#bulk-preview input[type="checkbox"]');
  assert.deepEqual(await checks.evaluateAll((els) => els.map((e) => e.checked)), [false, true, false, true, false], '問題のない2件だけ最初から選ばれる');
  assert.equal(await checks.nth(2).isDisabled(), true, '日本語訳がないものは選べない');
  const text = await page.textContent('#bulk-preview');
  assert.match(text, /登録済み/); assert.match(text, /日本語訳がありません/); assert.match(text, /4件目と同じ内容/);
  await page.screenshot({ path: join(shots, 'bulk-preview.png'), fullPage: true });
  await noSideScroll(page, 'まとめて登録の確認');
  // 修正すると選べる
  await page.locator('#bulk-preview .prev-item').nth(2).locator('input[aria-label="日本語訳"]').fill('もう一度言ってもらえますか?');
  assert.equal(await checks.nth(2).isDisabled(), false);
  await checks.nth(2).check();
  // 種類を変えて重複でなくする → 選べる
  await page.locator('#bulk-preview .prev-item').nth(3).locator('select').selectOption('word');
  await page.click('#bulk-commit');
  const list = await items(page);
  assert.equal(list.length, 4, '既存1件 + 選んだ3件');
  assert.equal(list.find((x) => x.en === 'postpone').ja, '延期する', '既存は上書きされない');
  assert.equal(list.find((x) => x.en === 'reluctant').example, 'She was "reluctant"\nto leave.');
  assert.equal(list.find((x) => x.en === "I'm on my way.").kind, 'word');
  // お願い文と入力例が表示されている
  assert.match(await page.textContent('#gpt-prompt'), /"items"/);
  assert.match(await page.textContent('#bulk-sample'), /"type": "word"/);
  await page.click('#bulk-input-panel details summary');
  await page.click('[data-copy="gpt-prompt"]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /JSON形式/, 'お願い文をコピーできる');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('バックアップの書き出しと復元(覚えた/まだ も戻る)', async () => {
  const { ctx, page, errors } = await open();
  await addItem(page, { kind: 'word', en: 'vivid', ja: '鮮やかな', note: '改行\nあり' });
  await tab(page, 'list');
  await page.click('#list li button[data-act="status"]');
  await tab(page, 'settings');
  await page.click('#backup-copy');
  const backup = await page.inputValue('#backup-out');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), backup);
  // 全部消えた状態を作る → 復元
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  assert.equal((await items(page)).length, 0);
  await addItem(page, { kind: 'word', en: 'other', ja: '別' });
  await tab(page, 'settings');
  await page.fill('#restore-in', backup);
  await page.click('#restore-run');
  const list = await items(page);
  assert.equal(list.length, 2, '今のデータは残したまま追加');
  assert.equal(list.find((x) => x.en === 'vivid').status, 'learned');
  assert.equal(list.find((x) => x.en === 'vivid').note, '改行\nあり');
  // 同じバックアップをもう一度戻しても増えない
  await page.fill('#restore-in', backup);
  await page.click('#restore-run');
  assert.equal((await items(page)).length, 2);
  await page.screenshot({ path: join(shots, 'settings.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('5. iPhone SE の幅で全画面が横スクロールしない', async () => {
  for (const vp of [SE1, SE]) {
    const { ctx, page, errors } = await open({ viewport: vp });
    await addItem(page, { kind: 'sentence', en: 'Supercalifragilisticexpialidocious-is-a-very-long-word-without-spaces', ja: 'とても長い単語' });
    for (const v of ['practice', 'add', 'bulk', 'list', 'settings']) {
      await tab(page, v);
      if (v === 'practice') await page.click('#practice-settings summary');
      if (v === 'bulk') { await page.click('#bulk-use-sample').catch(() => {}); }
      await noSideScroll(page, `${vp.width}px ${v}`);
      if (vp === SE1) await page.screenshot({ path: join(shots, `se1-${v}.png`) });
    }
    // 文字が小さすぎない(本文16px以上、ボタン44px以上の高さ)
    await tab(page, 'practice');
    const h = await page.locator('#reveal').evaluate((e) => e.getBoundingClientRect().height);
    assert.ok(h >= 44, 'ボタンが押しやすい高さ');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('5. ホーム画面用の設定とオフラインで開けること', async () => {
  const { ctx, page, errors } = await open();
  const manifest = await (await page.request.get(BASE + 'manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  assert.equal((await page.request.get(BASE + 'icons/apple-touch-icon.png')).status(), 200);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // service worker の管理下で開き直す
  await addItem(page, { kind: 'word', en: 'offline', ja: 'オフライン' });
  await ctx.setOffline(true);
  await page.reload();
  await tab(page, 'list');
  assert.equal(await page.locator('#list li').count(), 1, 'ネットなしでも開けて、データも見える');
  await addItem(page, { kind: 'word', en: 'airplane mode', ja: '機内モード' });
  assert.equal((await items(page)).length, 2, 'ネットなしでも登録できる');
  await ctx.setOffline(false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('6. 同期(テスト用の偽サーバー): 2台で同じデータ・失敗してもデータが消えない・古い内容で上書きしない', async () => {
  // サーバー側: 実物と同じ規則(新しい updated_at_ms だけ反映、server_updated_at を付ける)
  const fake = {
    rows: new Map(), tick: 0, fail: false, keys: [],
    ts() { return new Date(Date.UTC(2026, 0, 1) + (++this.tick) * 1000).toISOString(); },
    handle(q) {
      if (this.fail) return { data: null, error: { message: 'Failed to fetch' } };
      if (q.op === 'rpc' && q.name === 'eigo_push') {
        q.args.p_items.forEach((r) => {
          const cur = this.rows.get(r.id);
          if (!cur || cur.updated_at_ms < r.updated_at_ms) this.rows.set(r.id, Object.assign({}, r, { server_updated_at: this.ts() }));
        });
        return { data: q.args.p_items.map((r) => this.rows.get(r.id)), error: null };
      }
      if (q.table === 'items' && q.op === 'select') {
        const data = [...this.rows.values()].filter((r) => r.server_updated_at > q.gt).sort((a, b) => (a.server_updated_at < b.server_updated_at ? -1 : 1)).slice(0, q.limit);
        return { data, error: null };
      }
      if (q.table === 'api_keys') {
        if (q.op === 'insert') { this.keys.push(Object.assign({ id: 'k' + this.keys.length, created_at: new Date().toISOString() }, q.row)); return { data: null, error: null }; }
        return { data: this.keys.map((k) => ({ id: k.id, label: k.label, created_at: k.created_at, last_used_at: null, revoked_at: null })), error: null };
      }
      return { data: [], error: null };
    },
  };
  const conf = `localStorage.setItem('eigo-app:sync-config', JSON.stringify({ supabaseUrl: 'https://test.supabase.co', supabaseAnonKey: 'sb_publishable_testtesttesttest' }));`;
  const phone = await open({ fake, init: conf });
  const mac = await open({ fake, init: conf, viewport: { width: 1280, height: 800 } });
  // スマホに同期前のデータがある
  await addItem(phone.page, { kind: 'word', en: 'before-login', ja: 'ログイン前' });
  // 両方でログイン
  for (const d of [phone, mac]) {
    await tab(d.page, 'settings');
    await d.page.fill('#login-email', 'me@example.com');
    await d.page.fill('#login-pass', 'password123');
    await d.page.click('#sync-area button:text-is("ログイン")');
    await d.page.waitForFunction(() => document.getElementById('sync-chip').textContent === '同期済み');
  }
  await phone.page.screenshot({ path: join(shots, 'sync-settings.png'), fullPage: true });
  assert.equal(fake.rows.size, 1, 'ログイン前のデータも送られる(消えない)');
  await mac.page.evaluate(() => window.EigoApp && document.querySelector('#sync-panel .btn.soft').click());
  await mac.page.waitForFunction(() => JSON.parse(localStorage.getItem('eigo-app:items')).length === 1);
  // Macで「覚えた」→ スマホに届く
  await tab(mac.page, 'list');
  await mac.page.click('#list li button[data-act="status"]');
  await mac.page.waitForFunction(() => document.getElementById('sync-chip').textContent === '同期済み');
  await tab(phone.page, 'settings');
  await phone.page.click('#sync-panel .btn.soft');
  await phone.page.waitForFunction(() => JSON.parse(localStorage.getItem('eigo-app:items'))[0].status === 'learned');
  // 失敗: サーバーにつながらない間の変更は端末に残り、復旧後に送られる
  fake.fail = true;
  await addItem(phone.page, { kind: 'sentence', en: 'Saved while failing.', ja: '失敗中に登録' });
  await phone.page.waitForFunction(() => document.getElementById('sync-chip').textContent === '同期できていません', null, { timeout: 5000 });
  assert.equal((await items(phone.page)).length, 2, '失敗しても端末のデータは消えない');
  assert.equal((await items(phone.page)).find((x) => x.en === 'Saved while failing.').dirty, true);
  await phone.page.screenshot({ path: join(shots, 'sync-failed.png') });
  fake.fail = false;
  await tab(phone.page, 'settings');
  await phone.page.click('#sync-panel .btn.soft');
  await phone.page.waitForFunction(() => document.getElementById('sync-chip').textContent === '同期済み');
  assert.equal(fake.rows.size, 2);
  // 古い内容で上書きしない: Macで先に編集、スマホで後から編集 → 新しいスマホの内容が残る。逆順なら残らない
  const id = [...fake.rows.values()].find((r) => r.en === 'before-login').id;
  await mac.page.click('#sync-panel .btn.soft').catch(async () => { await tab(mac.page, 'settings'); await mac.page.click('#sync-panel .btn.soft'); });
  await mac.page.waitForFunction(() => JSON.parse(localStorage.getItem('eigo-app:items')).length === 2);
  // Mac の古い編集(時刻を過去にしたもの)を直接作って送らせる
  await mac.page.evaluate((id) => { const s = window.EigoApp.store; const x = s.get(id); s.upsert(Object.assign({}, x, { ja: '古い編集', updatedAt: x.updatedAt - 100000, dirty: true })); }, id);
  await mac.page.waitForTimeout(2500);
  assert.equal(fake.rows.get(id).ja, 'ログイン前', 'サーバーの新しい内容は古い編集で上書きされない');
  assert.equal((await items(mac.page)).find((x) => x.id === id).ja, 'ログイン前', 'Mac側もサーバーの新しい内容にそろう');
  // ChatGPT連携のキー作成画面
  await tab(phone.page, 'settings');
  await phone.page.click('text=連携用キーを作る');
  await phone.page.waitForSelector('#new-key');
  const key = await phone.page.textContent('#new-key');
  assert.match(key, /^eigo_[A-Za-z0-9]{40}$/);
  assert.equal(fake.keys.length, 1);
  assert.notEqual(fake.keys[0].key_hash, key, 'サーバーにはキーそのものではなくハッシュだけ送る');
  assert.match(fake.keys[0].key_hash, /^[0-9a-f]{64}$/);
  assert.equal(await phone.page.evaluate((k) => Object.values(localStorage).some((v) => v.includes(k)), key), false, 'キーは端末にも保存しない');
  assert.match(await phone.page.textContent('#gpt-schema'), /https:\/\/test\.supabase\.co\/functions\/v1\/eigo-api/);
  await phone.page.screenshot({ path: join(shots, 'gpt-settings.png'), fullPage: true });
  assert.deepEqual(phone.errors.filter((e) => !/Failed to fetch/.test(e)), []);
  assert.deepEqual(mac.errors, []);
  await phone.ctx.close(); await mac.ctx.close();
});

test('Claude の中で開く版(1ファイル)も動き、前のデータを引き継ぐ', async () => {
  const out = join(shots, 'artifact.html');
  execSync(`node ${join(here, '..', 'tools', 'build-artifact.mjs')} ${out}`);
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>' + readFileSync(out, 'utf8') + '</body></html>';
  const ctx = await browser.newContext({ viewport: SE });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://artifact.test/', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.addInitScript(`if (!sessionStorage.s) { localStorage.setItem('sentence-app:cards', '[{"id":"x","en":"Hello.","ja":"こんにちは。","createdAt":1}]'); sessionStorage.s = 1; }`);
  await page.goto('http://artifact.test/');
  assert.equal(await page.textContent('#card-q'), 'こんにちは。');
  await tab(page, 'settings');
  assert.match(await page.textContent('#sync-area'), /同期は使えません/);
  assert.equal(await page.isVisible('#backup-download'), false, 'ダウンロードできない画面ではボタンを出さない');
  assert.deepEqual(errors, []);
  await ctx.close();
});
