/*
 * 英語暗記帳のデータ処理(画面に依存しない部分)。
 * ブラウザでは window.EigoCore、Node のテストでは require() で使う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EigoCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KINDS = ['word', 'sentence'];
  const LIMITS = { en: 1000, ja: 1000, example: 2000, note: 2000 };

  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // 古いブラウザ向けの UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // 重複判定用に英語を揃える(大文字小文字・空白・引用符・文末記号の違いを無視)。
  // supabase/schema.sql の eigo_normalize と同じ規則。
  function normalizeKey(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[‘’`]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[\s.!?。!?]+$/, '');
  }

  function dedupeKey(kind, en) {
    return kind + '|' + normalizeKey(en);
  }

  function clean(s, max) {
    return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim().slice(0, max);
  }

  function makeItem(fields, now) {
    now = now || Date.now();
    return {
      id: fields.id || newId(),
      kind: KINDS.includes(fields.kind) ? fields.kind : 'sentence',
      en: clean(fields.en, LIMITS.en),
      ja: clean(fields.ja, LIMITS.ja),
      example: clean(fields.example, LIMITS.example),
      note: clean(fields.note, LIMITS.note),
      status: fields.status === 'learned' ? 'learned' : 'learning',
      createdAt: fields.createdAt || now,
      updatedAt: now,
      deleted: false,
      source: fields.source || 'app',
      dirty: true,
    };
  }

  // 旧「センテンス暗記」のデータ [{id,en,ja,createdAt}] を新形式に変換する。
  function migrateLegacy(cards, now) {
    now = now || Date.now();
    if (!Array.isArray(cards)) return [];
    return cards
      .filter((c) => c && c.en && c.ja)
      .map((c, i) => {
        const item = makeItem({ kind: 'sentence', en: c.en, ja: c.ja, createdAt: c.createdAt || now - (cards.length - i), source: 'legacy' }, now);
        item.legacyId = c.id || null;
        return item;
      });
  }

  function live(items) {
    return items.filter((x) => !x.deleted);
  }

  function findDuplicate(items, kind, en, excludeId) {
    const key = dedupeKey(kind, en);
    return live(items).find((x) => x.id !== excludeId && dedupeKey(x.kind, x.en) === key) || null;
  }

  // ---- 出題 ----
  function filterForPractice(items, settings) {
    return live(items)
      .filter((x) => settings.target === 'all' || x.kind === settings.target)
      .filter((x) => settings.scope === 'all' || x.status !== 'learned')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function buildQueue(items, settings, rng) {
    const ids = filterForPractice(items, settings).map((x) => x.id);
    if (settings.order === 'random') {
      rng = rng || Math.random;
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
    }
    return ids;
  }

  // ---- まとめて登録 ----
  function parseKind(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (['word', 'words', 'w', '単語', 'たんご', 'vocab', 'vocabulary'].includes(s)) return 'word';
    if (['sentence', 'sentences', 's', 'センテンス', '英文', '文', 'phrase', 'expression', 'フレーズ'].includes(s)) return 'sentence';
    return null;
  }

  function guessKind(en) {
    return String(en || '').trim().split(/\s+/).length >= 3 ? 'sentence' : 'word';
  }

  function positionToLineCol(text, pos) {
    const before = text.slice(0, pos);
    const lines = before.split('\n');
    return { line: lines.length, col: lines[lines.length - 1].length + 1 };
  }

  function jsonErrorInfo(text, err) {
    const msg = String(err && err.message || err);
    let pos = null;
    const m = msg.match(/position (\d+)/);
    if (m) pos = Number(m[1]);
    const lc = msg.match(/line (\d+) column (\d+)/);
    let where = null;
    if (pos != null) where = positionToLineCol(text, pos);
    else if (lc) where = { line: Number(lc[1]), col: Number(lc[2]) };
    let hint = '';
    if (/Unexpected end/i.test(msg)) hint = '最後の } や ] が足りない可能性があります。';
    else if (/Unexpected token/i.test(msg) || /Expected/i.test(msg)) hint = '「,」の付け忘れ・付けすぎ、または "" で囲まれていない文字がないか確認してください。';
    return { where, hint, raw: msg };
  }

  function stripWrapper(text) {
    let t = String(text || '').replace(/^﻿/, '').trim();
    const fence = t.match(/```(?:json|JSON)?\s*\n([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    // ChatGPT の前置き・後書きを除く
    const first = t.search(/[[{]/);
    if (first > 0) t = t.slice(first);
    const lastObj = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (lastObj >= 0 && lastObj < t.length - 1) t = t.slice(0, lastObj + 1);
    // 全角の引用符で書かれていた場合の救済はしない(本文中の「”」を壊すため)
    return t;
  }

  /**
   * 貼り付けられた文章を読み取る。
   * 返り値: { ok:true, rows:[...] } または { ok:false, error:{ message, where, hint } }
   */
  function parseBulk(text) {
    const src = stripWrapper(text);
    if (!src) return { ok: false, error: { message: '何も入力されていません。ChatGPTの回答を貼り付けてください。' } };
    let data;
    try {
      data = JSON.parse(src);
    } catch (e) {
      const info = jsonErrorInfo(src, e);
      return {
        ok: false,
        error: {
          message: 'JSONの形式として読み取れませんでした。' + (info.where ? '(' + info.where.line + '行目 ' + info.where.col + '文字目付近)' : ''),
          hint: info.hint,
          where: info.where,
        },
      };
    }
    let list = null;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.items)) list = data.items;
    else if (data && (Array.isArray(data.words) || Array.isArray(data.sentences))) {
      list = [].concat(
        (data.words || []).map((x) => Object.assign({ type: 'word' }, x)),
        (data.sentences || []).map((x) => Object.assign({ type: 'sentence' }, x))
      );
    }
    if (!list) {
      return { ok: false, error: { message: '"items" の一覧が見つかりませんでした。{"items": [ ... ]} の形にしてください。' } };
    }
    if (list.length === 0) return { ok: false, error: { message: '登録する項目が0件です。' } };
    if (list.length > 500) return { ok: false, error: { message: '一度に読み取れるのは500件までです(' + list.length + '件ありました)。分けて貼り付けてください。' } };

    const rows = list.map((raw, i) => {
      const r = raw && typeof raw === 'object' ? raw : {};
      const en = clean(r.en != null ? r.en : (r.english != null ? r.english : r.英語), LIMITS.en);
      const ja = clean(r.ja != null ? r.ja : (r.japanese != null ? r.japanese : r.日本語), LIMITS.ja);
      const typeRaw = r.type != null ? r.type : (r.kind != null ? r.kind : r.種類);
      let kind = parseKind(typeRaw);
      let kindNote = null;
      const notObject = !(raw && typeof raw === 'object' && !Array.isArray(raw));
      if (!kind) {
        kind = guessKind(en);
        if (!notObject) {
          kindNote = typeRaw == null || typeRaw === '' ? '種類の指定がないため自動で判定しました' : '種類「' + String(typeRaw) + '」がわからないため自動で判定しました';
        }
      }
      return {
        index: i + 1,
        kind,
        kindNote,
        en,
        ja,
        example: clean(r.example != null ? r.example : r.例文, LIMITS.example),
        note: clean(r.note != null ? r.note : r.メモ, LIMITS.note),
        notObject,
      };
    });
    return { ok: true, rows };
  }

  /**
   * 各行の問題点を調べる。rows は破壊的に更新する(issues, selectable)。
   */
  function validateRows(rows, items) {
    const existing = new Map();
    live(items).forEach((x) => existing.set(dedupeKey(x.kind, x.en), x));
    const seen = new Map();
    rows.forEach((r) => {
      const issues = [];
      if (r.notObject) issues.push({ level: 'error', code: 'format', text: '形式が正しくありません' });
      if (!r.en) issues.push({ level: 'error', code: 'missing_en', text: '英語がありません' });
      if (!r.ja) issues.push({ level: 'error', code: 'missing_ja', text: '日本語訳がありません' });
      if (r.kindNote) issues.push({ level: 'warn', code: 'kind_guess', text: r.kindNote });
      if (r.en) {
        const key = dedupeKey(r.kind, r.en);
        const ex = existing.get(key);
        if (ex) issues.push({ level: 'dup', code: 'dup_existing', text: '登録済み:「' + ex.en + '」' });
        if (seen.has(key)) issues.push({ level: 'dup', code: 'dup_batch', text: seen.get(key) + '件目と同じ内容' });
        else seen.set(key, r.index);
      }
      r.issues = issues;
      r.hasError = issues.some((x) => x.level === 'error');
      r.isDup = issues.some((x) => x.level === 'dup');
    });
    return rows;
  }

  // ---- バックアップ ----
  function exportBackup(items, now) {
    return JSON.stringify({
      app: 'eigo-anki',
      version: 2,
      exportedAt: new Date(now || Date.now()).toISOString(),
      items: items.map((x) => {
        const o = Object.assign({}, x);
        delete o.dirty;
        return o;
      }),
    });
  }

  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(stripWrapper(text));
    } catch (e) {
      return { ok: false, error: 'バックアップの文字を読み取れませんでした。書き出したときの文字をそのまま貼り付けてください。' };
    }
    const now = Date.now();
    // 新形式
    if (data && data.app === 'eigo-anki' && Array.isArray(data.items)) {
      const items = data.items
        .filter((x) => x && x.id && x.en != null && x.ja != null)
        .map((x) => Object.assign(makeItem(x, x.updatedAt || now), {
          id: String(x.id),
          createdAt: Number(x.createdAt) || now,
          updatedAt: Number(x.updatedAt) || now,
          deleted: !!x.deleted,
          status: x.status === 'learned' ? 'learned' : 'learning',
          dirty: true,
        }));
      return { ok: true, items, format: 'backup' };
    }
    // 旧「センテンス暗記」の書き出し [{en,ja}]
    if (Array.isArray(data) && data.every((x) => x && typeof x.en === 'string' && typeof x.ja === 'string' && x.type == null && x.kind == null)) {
      return { ok: true, items: migrateLegacy(data, now), format: 'legacy' };
    }
    return { ok: false, error: 'この画面ではバックアップの文字だけを読み込めます。ChatGPTの一覧は「まとめて」画面から登録してください。' };
  }

  /**
   * バックアップを今のデータに混ぜる。消したり古い内容で上書きしたりはしない。
   * 同じ id は新しいほうを採用。id が違っても同じ内容(種類+英語)なら追加しない。
   */
  function mergeBackup(items, incoming) {
    const byId = new Map(items.map((x) => [x.id, x]));
    const keys = new Set(live(items).map((x) => dedupeKey(x.kind, x.en)));
    let added = 0, updated = 0, skipped = 0;
    const result = items.slice();
    incoming.forEach((inc) => {
      const cur = byId.get(inc.id);
      if (cur) {
        if (inc.updatedAt > cur.updatedAt) {
          const idx = result.indexOf(cur);
          result[idx] = Object.assign({}, inc, { dirty: true });
          updated++;
        } else skipped++;
        return;
      }
      if (inc.deleted) { skipped++; return; }
      const key = dedupeKey(inc.kind, inc.en);
      if (keys.has(key)) { skipped++; return; }
      keys.add(key);
      result.push(Object.assign({}, inc, { dirty: true }));
      added++;
    });
    return { items: result, added, updated, skipped };
  }

  // ---- 同期 ----
  function toRow(x) {
    return {
      id: x.id,
      kind: x.kind,
      en: x.en,
      ja: x.ja,
      example: x.example || '',
      note: x.note || '',
      status: x.status,
      deleted: !!x.deleted,
      source: x.source || 'app',
      created_at_ms: x.createdAt,
      updated_at_ms: x.updatedAt,
    };
  }

  function fromRow(r) {
    return {
      id: r.id,
      kind: r.kind,
      en: r.en,
      ja: r.ja,
      example: r.example || '',
      note: r.note || '',
      status: r.status === 'learned' ? 'learned' : 'learning',
      deleted: !!r.deleted,
      source: r.source || 'app',
      createdAt: Number(r.created_at_ms),
      updatedAt: Number(r.updated_at_ms),
      dirty: false,
    };
  }

  /**
   * サーバーから届いた行を端末のデータに混ぜる。
   * 新しいほう(updatedAt が大きいほう)が勝つ。端末のほうが新しければ端末を残して後で送る。
   * 返り値: { items, changed }
   */
  function mergeRemote(items, rows) {
    const byId = new Map(items.map((x, i) => [x.id, i]));
    const result = items.slice();
    let changed = 0;
    rows.forEach((row) => {
      const remote = fromRow(row);
      const i = byId.get(remote.id);
      if (i == null) {
        byId.set(remote.id, result.length);
        result.push(remote);
        changed++;
        return;
      }
      const local = result[i];
      if (remote.updatedAt > local.updatedAt) {
        result[i] = remote;
        changed++;
      } else if (remote.updatedAt === local.updatedAt && local.dirty) {
        result[i] = Object.assign({}, local, { dirty: false });
      }
    });
    return { items: result, changed };
  }

  // 送信が終わったものの「未送信」印を外す。送信中に編集されたものは残す。
  function markPushed(items, sent) {
    const sentAt = new Map(sent.map((x) => [x.id, x.updatedAt]));
    return items.map((x) => (sentAt.has(x.id) && sentAt.get(x.id) === x.updatedAt ? Object.assign({}, x, { dirty: false }) : x));
  }

  return {
    KINDS, LIMITS, newId, normalizeKey, dedupeKey, makeItem, migrateLegacy, live, findDuplicate,
    filterForPractice, buildQueue, parseKind, parseBulk, validateRows,
    exportBackup, parseBackup, mergeBackup, toRow, fromRow, mergeRemote, markPushed,
  };
});
