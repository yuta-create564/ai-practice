// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../sentence-app/core.js');

test('旧データの引き継ぎ: 全件がセンテンスとして残る', () => {
  const old = [{ id: 'a1', en: 'See you later.', ja: 'またね。', createdAt: 10 }, { id: 'a2', en: 'Thank you.', ja: 'ありがとう。', createdAt: 20 }];
  const items = C.migrateLegacy(old, 1000);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((x) => [x.kind, x.en, x.ja, x.status, x.legacyId, x.createdAt]),
    [['sentence', 'See you later.', 'またね。', 'learning', 'a1', 10], ['sentence', 'Thank you.', 'ありがとう。', 'learning', 'a2', 20]]);
  assert.match(items[0].id, /^[0-9a-f-]{36}$/);
});

test('重複判定: 大文字小文字・空白・文末記号・引用符の違いは同じ扱い', () => {
  assert.equal(C.normalizeKey('  I’m  FINE! '), C.normalizeKey("i'm fine"));
  const items = [C.makeItem({ kind: 'word', en: 'Postpone', ja: '延期する' })];
  assert.ok(C.findDuplicate(items, 'word', 'postpone.'));
  assert.equal(C.findDuplicate(items, 'sentence', 'postpone'), null, '種類が違えば別物');
  assert.equal(C.findDuplicate(items, 'word', 'postpone', items[0].id), null, '編集中の自分自身は除く');
  items[0].deleted = true;
  assert.equal(C.findDuplicate(items, 'word', 'postpone'), null, '削除済みは対象外');
});

test('出題: 対象・範囲・順番', () => {
  const mk = (kind, en, status, t) => Object.assign(C.makeItem({ kind, en, ja: 'x', status }), { createdAt: t });
  const items = [mk('word', 'b', 'learned', 2), mk('sentence', 'a b c', 'learning', 1), mk('word', 'c', 'learning', 3)];
  const en = (ids) => ids.map((id) => items.find((x) => x.id === id).en);
  assert.deepEqual(en(C.buildQueue(items, { target: 'all', scope: 'all', order: 'ordered' })), ['a b c', 'b', 'c']);
  assert.deepEqual(en(C.buildQueue(items, { target: 'word', scope: 'all', order: 'ordered' })), ['b', 'c']);
  assert.deepEqual(en(C.buildQueue(items, { target: 'all', scope: 'learning', order: 'ordered' })), ['a b c', 'c']);
  const r = C.buildQueue(items, { target: 'all', scope: 'all', order: 'random' }, () => 0);
  assert.equal(r.length, 3);
  assert.notDeepEqual(en(r), ['a b c', 'b', 'c']);
});

test('まとめて登録: ChatGPTの前置きやコードブロックがあっても読める', () => {
  const text = 'はい、どうぞ!\n```json\n{"items":[{"type":"word","en":"postpone","ja":"延期する","example":"Line1\\nLine2 \\"q\\""}]}\n```\n以上です。';
  const r = C.parseBulk(text);
  assert.ok(r.ok);
  assert.equal(r.rows[0].example, 'Line1\nLine2 "q"');
});

test('まとめて登録: 配列だけ・words/sentences 形式・日本語の種類名も読める', () => {
  assert.equal(C.parseBulk('[{"type":"単語","en":"a","ja":"b"}]').rows[0].kind, 'word');
  const r = C.parseBulk('{"words":[{"en":"a","ja":"b"}],"sentences":[{"en":"c d e","ja":"f"}]}');
  assert.deepEqual(r.rows.map((x) => x.kind), ['word', 'sentence']);
});

test('まとめて登録: 形式の誤りは行と位置を示す', () => {
  const r = C.parseBulk('{"items":[\n{"type":"word","en":"a","ja":"b"}\n{"type":"word","en":"c","ja":"d"}]}');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /3行目/);
  assert.equal(C.parseBulk('').ok, false);
  assert.match(C.parseBulk('{"foo":1}').error.message, /items/);
});

test('まとめて登録: 必須項目不足・種類不明・重複を見つける', () => {
  const existing = [C.makeItem({ kind: 'word', en: 'postpone', ja: '延期する' })];
  const r = C.parseBulk(JSON.stringify({ items: [
    { type: 'word', en: 'Postpone', ja: '延期' },
    { type: 'sentence', en: 'See you.', ja: '' },
    { type: 'xx', en: 'cancel', ja: '取り消す' },
    { type: 'word', en: 'cancel', ja: '中止する' },
    'not an object',
  ] }));
  C.validateRows(r.rows, existing);
  const codes = r.rows.map((x) => x.issues.map((i) => i.code).sort().join(','));
  assert.deepEqual(codes, ['dup_existing', 'missing_ja', 'kind_guess', 'dup_batch', 'format,missing_en,missing_ja']);
  assert.deepEqual(r.rows.map((x) => x.hasError), [false, true, false, false, true]);
});

test('バックアップ: 書き出し→戻すで内容と状態が残り、今のデータは消えない', () => {
  const a = C.makeItem({ kind: 'word', en: 'a', ja: 'あ', status: 'learned' });
  const b = C.makeItem({ kind: 'sentence', en: 'b c d', ja: 'い', note: '改行\nあり' });
  const text = C.exportBackup([a, b]);
  const parsed = C.parseBackup(text);
  assert.ok(parsed.ok);
  assert.equal(parsed.items[0].status, 'learned');
  assert.equal(parsed.items[1].note, '改行\nあり');
  const current = [C.makeItem({ kind: 'word', en: 'z', ja: 'ぜ' })];
  const m = C.mergeBackup(current, parsed.items);
  assert.equal(m.items.length, 3);
  assert.equal(m.added, 2);
  // 同じものをもう一度戻しても増えない
  assert.equal(C.mergeBackup(m.items, parsed.items).added, 0);
});

test('バックアップ: 同じ項目は新しいほうを残す(古いバックアップで上書きしない)', () => {
  const a = Object.assign(C.makeItem({ kind: 'word', en: 'a', ja: '古い' }, 100), { updatedAt: 100 });
  const newer = Object.assign({}, a, { ja: '新しい', updatedAt: 200 });
  assert.equal(C.mergeBackup([newer], [a]).items[0].ja, '新しい');
  assert.equal(C.mergeBackup([a], [newer]).items[0].ja, '新しい');
});

test('バックアップ: 旧アプリの書き出し形式も読める', () => {
  const r = C.parseBackup('[{"en":"See you.","ja":"またね"}]');
  assert.ok(r.ok);
  assert.equal(r.items[0].kind, 'sentence');
  assert.equal(C.parseBackup('壊れた文字').ok, false);
});

test('同期: 新しいほうが勝ち、端末のほうが新しければ残して送る', () => {
  const local = Object.assign(C.makeItem({ kind: 'word', en: 'a', ja: '端末' }), { updatedAt: 300, dirty: true });
  const olderRemote = Object.assign(C.toRow(local), { ja: 'サーバー', updated_at_ms: 200 });
  let m = C.mergeRemote([local], [olderRemote]);
  assert.equal(m.items[0].ja, '端末');
  assert.equal(m.items[0].dirty, true);
  const newerRemote = Object.assign(C.toRow(local), { ja: 'サーバー', updated_at_ms: 400 });
  m = C.mergeRemote([local], [newerRemote]);
  assert.equal(m.items[0].ja, 'サーバー');
  assert.equal(m.items[0].dirty, false);
  const same = C.toRow(local);
  assert.equal(C.mergeRemote([local], [same]).items[0].dirty, false, '同じ版が届いたら送信済み');
  const other = C.toRow(C.makeItem({ kind: 'word', en: 'new', ja: '新' }));
  assert.equal(C.mergeRemote([local], [other]).items.length, 2);
});

test('同期: 送信中に編集されたものは未送信のまま残る', () => {
  const x = Object.assign(C.makeItem({ kind: 'word', en: 'a', ja: 'a' }), { updatedAt: 10 });
  const edited = Object.assign({}, x, { ja: 'b', updatedAt: 11, dirty: true });
  assert.equal(C.markPushed([edited], [x])[0].dirty, true);
  assert.equal(C.markPushed([x], [x])[0].dirty, false);
});
