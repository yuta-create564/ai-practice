/* 英語暗記帳の画面と保存処理 */
(function () {
  'use strict';
  const C = window.EigoCore;
  const ENV = window.EIGO_ENV || 'web'; // 'artifact' のときは Claude の画面内で動いている

  const KEYS = {
    items: 'eigo-app:items',
    settings: 'eigo-app:settings',
    legacy: 'sentence-app:cards',
    legacyDir: 'sentence-app:direction',
    legacyBackup: 'eigo-app:legacy-backup',
    migrated: 'eigo-app:migrated',
  };

  // ---------------- 保存 ----------------
  let storageOk = true;
  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { storageOk = false; return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); return true; } catch (e) { storageOk = false; return false; }
  }
  function lsJSON(k, fallback) {
    const raw = lsGet(k);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  const listeners = [];
  const store = {
    items: [],
    load() {
      const saved = lsJSON(KEYS.items, null);
      if (Array.isArray(saved)) { this.items = saved; return null; }
      // 初回: 旧「センテンス暗記」のデータを引き継ぐ。旧データは消さずに残す。
      const legacyRaw = lsGet(KEYS.legacy);
      let migrated = null;
      if (legacyRaw) {
        let cards = [];
        try { cards = JSON.parse(legacyRaw) || []; } catch (e) { cards = []; }
        if (lsGet(KEYS.legacyBackup) == null) lsSet(KEYS.legacyBackup, legacyRaw);
        this.items = C.migrateLegacy(cards);
        migrated = { count: this.items.length, at: Date.now() };
        lsSet(KEYS.migrated, JSON.stringify(migrated));
      } else {
        this.items = [];
      }
      this.persist();
      return migrated;
    },
    persist() {
      const ok = lsSet(KEYS.items, JSON.stringify(this.items));
      if (!ok) showStorageWarning();
      return ok;
    },
    all() { return this.items; },
    live() { return C.live(this.items); },
    get(id) { return this.items.find((x) => x.id === id) || null; },
    // 画面からの変更(未送信の印を付ける)
    upsert(item) {
      const i = this.items.findIndex((x) => x.id === item.id);
      if (i >= 0) this.items[i] = item; else this.items.push(item);
      this.persist();
      this.emit('local');
    },
    update(id, patch) {
      const cur = this.get(id);
      if (!cur) return null;
      const next = Object.assign({}, cur, patch, { updatedAt: Math.max(Date.now(), cur.updatedAt + 1), dirty: true });
      this.upsert(next);
      return next;
    },
    addMany(newItems) {
      this.items = this.items.concat(newItems);
      this.persist();
      this.emit('local');
    },
    // 同期やバックアップで丸ごと差し替えるとき
    replaceAll(items, reason) {
      this.items = items;
      this.persist();
      this.emit(reason || 'remote');
    },
    subscribe(fn) { listeners.push(fn); },
    emit(reason) { listeners.forEach((fn) => { try { fn(reason); } catch (e) { console.error(e); } }); },
  };

  const defaultSettings = { direction: 'ja2en', target: 'all', scope: 'all', order: 'random' };
  let settings = Object.assign({}, defaultSettings, lsJSON(KEYS.settings, {}));
  if (!lsGet(KEYS.settings)) {
    const oldDir = lsGet(KEYS.legacyDir);
    if (oldDir === 'en2ja' || oldDir === 'ja2en') settings.direction = oldDir;
  }
  function saveSettings() { lsSet(KEYS.settings, JSON.stringify(settings)); }

  // ---------------- 共通 ----------------
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach((c) => { if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function showStorageWarning() { $('storage-warning').hidden = false; }
  const KIND_LABEL = { word: '単語', sentence: 'センテンス' };
  function kindChip(kind) { return el('span', { class: 'chip ' + kind, text: KIND_LABEL[kind] }); }
  function statusChip(status) {
    return status === 'learned' ? el('span', { class: 'chip good', text: '覚えた' }) : el('span', { class: 'chip', text: 'まだ' });
  }
  function copyText(text, okMsg, fallbackEl) {
    const fail = () => {
      if (fallbackEl) { fallbackEl.hidden = false; fallbackEl.focus(); fallbackEl.select && fallbackEl.select(); }
      toast('自動でコピーできませんでした。文字を長押ししてコピーしてください');
    };
    try {
      navigator.clipboard.writeText(text).then(() => toast(okMsg || 'コピーしました'), fail);
    } catch (e) { fail(); }
  }
  function setSeg(segEl, value) {
    segEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
  }

  // ---------------- タブ ----------------
  let currentView = 'practice';
  function showView(name) {
    currentView = name;
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'practice') { if (practice.stale) startPractice(); else renderPractice(); }
    if (name === 'list') renderList();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ---------------- 練習 ----------------
  const practice = { queue: [], pos: 0, revealed: false, done: false, stale: true, stats: { learned: 0, learning: 0 } };

  function settingsSummary() {
    const d = settings.direction === 'ja2en' ? '日→英' : '英→日';
    const t = { word: '単語', sentence: 'センテンス', all: '単語+センテンス' }[settings.target];
    const s = settings.scope === 'all' ? '全部' : 'まだのもの';
    const o = settings.order === 'random' ? 'ランダム' : '登録順';
    $('settings-summary').textContent = [d, t, s, o].join('・');
  }
  document.querySelectorAll('#practice-settings .seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[seg.dataset.setting] = b.dataset.value;
      saveSettings();
      setSeg(seg, b.dataset.value);
      settingsSummary();
      if (seg.dataset.setting === 'direction') { practice.revealed = false; renderPractice(); }
      else startPractice();
    });
  });
  function syncSettingsUI() {
    document.querySelectorAll('#practice-settings .seg').forEach((seg) => setSeg(seg, settings[seg.dataset.setting]));
    settingsSummary();
  }

  function startPractice() {
    practice.queue = C.buildQueue(store.all(), settings);
    practice.pos = 0;
    practice.revealed = false;
    practice.done = false;
    practice.stale = false;
    practice.stats = { learned: 0, learning: 0 };
    renderPractice();
  }

  function currentCard() {
    // 他の端末で消された等でなくなったカードは飛ばす
    while (practice.pos < practice.queue.length) {
      const item = store.get(practice.queue[practice.pos]);
      if (item && !item.deleted) return item;
      practice.queue.splice(practice.pos, 1);
    }
    return null;
  }

  function renderPractice() {
    const area = $('practice-area');
    area.textContent = '';
    const total = store.live().length;
    if (total === 0) {
      area.append(el('div', { class: 'panel empty' }, [
        'まだ何も登録されていません。', el('br'), '「登録」か「まとめて」から追加してください。',
      ]));
      return;
    }
    const card = practice.done ? null : currentCard();
    if (!card) {
      const any = practice.queue.length > 0 || practice.stats.learned + practice.stats.learning > 0;
      const box = el('div', { class: 'panel', style: 'text-align:center;gap:14px' });
      if (any) {
        box.append(el('h2', { text: '一周しました' }),
          el('p', { class: 'muted', text: '今回「覚えた」' + practice.stats.learned + '件・「まだ」' + practice.stats.learning + '件' }));
      } else {
        const msg = settings.scope === 'learning' ? 'この条件で「まだ」のものはありません。全部覚えました!' : 'この条件に合うものがありません。';
        box.append(el('p', { class: 'muted', text: msg }), el('p', { class: 'muted small', text: '上の「出題設定」で対象や範囲を変えられます。' }));
      }
      box.append(el('button', { class: 'btn', type: 'button', text: 'もう一周する', onclick: startPractice }));
      area.append(box);
      return;
    }

    const ja2en = settings.direction === 'ja2en';
    const q = ja2en ? card.ja : card.en;
    const a = ja2en ? card.en : card.ja;
    const cardEl = el('div', { class: 'card', id: 'card', role: 'button', tabindex: '0', 'aria-label': practice.revealed ? '答えを表示中' : 'タップして答えを見る' }, [
      el('div', { class: 'meta' }, [kindChip(card.kind), statusChip(card.status),
        el('span', { class: 'count', text: (practice.pos + 1) + ' / ' + practice.queue.length })]),
      el('div', {}, [
        el('div', { class: 'label', text: ja2en ? '日本語' : 'ENGLISH' }),
        el('div', { class: 'q' + (ja2en ? '' : ' en'), id: 'card-q', text: q }),
      ]),
    ]);
    if (practice.revealed) {
      const ans = el('div', { class: 'answer' }, [
        el('div', { class: 'label', text: ja2en ? 'ENGLISH' : '日本語' }),
        el('div', { class: 'a' + (ja2en ? ' en' : ''), id: 'card-a', text: a }),
      ]);
      if (card.example) ans.append(el('div', { class: 'extra' }, [el('b', { text: '例文' }), card.example]));
      if (card.note) ans.append(el('div', { class: 'extra' }, [el('b', { text: 'メモ' }), card.note]));
      cardEl.append(ans);
    } else {
      cardEl.append(el('div', { class: 'hint', text: '答えを思い浮かべたら、タップして答えを見る' }));
    }
    const reveal = () => { if (!practice.revealed) { practice.revealed = true; renderPractice(); } };
    cardEl.addEventListener('click', reveal);
    cardEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
    area.append(cardEl);

    if (practice.revealed) {
      area.append(el('div', { class: 'row', style: 'margin-top:12px' }, [
        el('button', { class: 'btn bad', type: 'button', id: 'mark-learning', text: 'まだ', onclick: () => mark('learning') }),
        el('button', { class: 'btn good', type: 'button', id: 'mark-learned', text: '覚えた', onclick: () => mark('learned') }),
      ]));
    } else {
      area.append(el('div', { class: 'row', style: 'margin-top:12px' }, [
        el('button', { class: 'btn', type: 'button', id: 'reveal', text: '答えを見る', onclick: reveal }),
      ]));
    }
    area.append(el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('button', { class: 'btn sm plain', type: 'button', id: 'prev', text: '← 前へ', disabled: practice.pos === 0, onclick: prev }),
      el('button', { class: 'btn sm plain', type: 'button', id: 'skip', text: 'とばす →', onclick: () => advance() }),
    ]));
  }

  function mark(status) {
    const card = currentCard();
    if (!card) return;
    if (card.status !== status) store.update(card.id, { status });
    practice.stats[status]++;
    toast(status === 'learned' ? '「覚えた」にしました' : '「まだ」にしました');
    advance();
  }
  function advance() {
    practice.pos++;
    practice.revealed = false;
    if (practice.pos >= practice.queue.length) practice.done = true;
    renderPractice();
  }
  function prev() {
    if (practice.pos > 0) practice.pos--;
    practice.revealed = false;
    practice.done = false;
    renderPractice();
  }

  // ---------------- 1件ずつ登録・編集 ----------------
  const form = { kind: 'sentence', editingId: null, forceDup: false, dupId: null };
  const formKindSeg = $('form-kind');
  formKindSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    form.kind = b.dataset.value;
    setSeg(formKindSeg, form.kind);
    $('f-en').placeholder = form.kind === 'word' ? '例: postpone' : "例: I'm looking forward to seeing you.";
    $('f-ja').placeholder = form.kind === 'word' ? '例: 延期する' : '例: あなたに会えるのを楽しみにしています。';
    hideDup();
  });
  ['f-en'].forEach((id) => $(id).addEventListener('input', hideDup));
  function hideDup() { $('dup-warning').hidden = true; form.forceDup = false; form.dupId = null; }

  function resetForm() {
    form.editingId = null;
    $('item-form').reset();
    hideDup();
    $('form-title').textContent = '1件ずつ登録';
    $('f-submit').textContent = '保存する';
    $('f-cancel').hidden = true;
  }
  function startEdit(id) {
    const item = store.get(id);
    if (!item) return;
    showView('add');
    form.editingId = id;
    form.kind = item.kind;
    setSeg(formKindSeg, item.kind);
    $('f-en').value = item.en;
    $('f-ja').value = item.ja;
    $('f-example').value = item.example || '';
    $('f-note').value = item.note || '';
    hideDup();
    $('form-title').textContent = '編集';
    $('f-submit').textContent = '更新する';
    $('f-cancel').hidden = false;
    $('f-en').focus();
  }
  $('f-cancel').addEventListener('click', () => { resetForm(); showView('list'); });
  $('dup-edit').addEventListener('click', () => { if (form.dupId) startEdit(form.dupId); });
  $('dup-force').addEventListener('click', () => { form.forceDup = true; $('item-form').requestSubmit ? $('item-form').requestSubmit() : submitForm(); });

  $('item-form').addEventListener('submit', (e) => { e.preventDefault(); submitForm(); });
  function submitForm() {
    const fields = {
      kind: form.kind,
      en: $('f-en').value.trim(),
      ja: $('f-ja').value.trim(),
      example: $('f-example').value.trim(),
      note: $('f-note').value.trim(),
    };
    if (!fields.en || !fields.ja) { toast('英語と日本語訳の両方を入れてください'); return; }
    const dup = C.findDuplicate(store.all(), fields.kind, fields.en, form.editingId);
    if (dup && !form.forceDup) {
      form.dupId = dup.id;
      $('dup-text').textContent = '「' + dup.en + '」(' + dup.ja + ')';
      $('dup-warning').hidden = false;
      $('dup-warning').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (form.editingId) {
      store.update(form.editingId, fields);
      toast('更新しました');
      resetForm();
      practice.stale = true;
      showView('list');
    } else {
      store.upsert(C.makeItem(fields));
      toast('保存しました');
      const keepKind = form.kind;
      resetForm();
      form.kind = keepKind;
      setSeg(formKindSeg, keepKind);
      practice.stale = true;
      $('f-en').focus();
    }
  }

  // ---------------- 一覧 ----------------
  const listFilter = { q: '', kind: 'all', status: 'all' };
  let pendingDelete = null;
  $('list-q').addEventListener('input', (e) => { listFilter.q = e.target.value; renderList(); });
  [['list-kind', 'kind'], ['list-status', 'status']].forEach(([id, key]) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      listFilter[key] = b.dataset.value;
      setSeg($(id), b.dataset.value);
      renderList();
    });
  });

  function renderList() {
    const q = listFilter.q.trim().toLowerCase();
    const all = store.live();
    const rows = all
      .filter((x) => listFilter.kind === 'all' || x.kind === listFilter.kind)
      .filter((x) => listFilter.status === 'all' || x.status === listFilter.status)
      .filter((x) => !q || [x.en, x.ja, x.example, x.note].some((s) => (s || '').toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt - a.createdAt);
    const words = all.filter((x) => x.kind === 'word').length;
    $('list-count').textContent = '全' + all.length + '件(単語' + words + '・センテンス' + (all.length - words) + ')' + (rows.length !== all.length ? ' / 表示' + rows.length + '件' : '');
    const list = $('list');
    list.textContent = '';
    if (all.length === 0) { list.append(el('li', { class: 'empty', text: '登録したものがここに並びます。' })); return; }
    if (rows.length === 0) { list.append(el('li', { class: 'empty', text: '見つかりませんでした。' })); return; }
    const frag = document.createDocumentFragment();
    rows.forEach((x) => {
      const li = el('li', { dataset: { id: x.id } }, [
        el('div', { class: 'row', style: 'gap:6px' }, [kindChip(x.kind), statusChip(x.status)]),
        el('div', { class: 'en-text', text: x.en }),
        el('div', { class: 'ja-text', text: x.ja }),
      ]);
      if (x.example) li.append(el('div', { class: 'extra', text: '例文: ' + x.example }));
      if (x.note) li.append(el('div', { class: 'extra', text: 'メモ: ' + x.note }));
      li.append(el('div', { class: 'actions' }, [
        el('button', { class: 'btn sm plain', type: 'button', 'data-act': 'status', text: x.status === 'learned' ? '「まだ」に戻す' : '「覚えた」にする' }),
        el('button', { class: 'btn sm plain', type: 'button', 'data-act': 'edit', text: '編集' }),
        el('button', { class: 'btn sm bad', type: 'button', 'data-act': 'delete', text: pendingDelete === x.id ? 'もう一度押すと削除' : '削除' }),
      ]));
      frag.append(li);
    });
    list.append(frag);
  }
  $('list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.id;
    const item = store.get(id);
    if (!item) return;
    const act = b.dataset.act;
    if (act !== 'delete') pendingDelete = null;
    if (act === 'edit') return startEdit(id);
    if (act === 'status') {
      store.update(id, { status: item.status === 'learned' ? 'learning' : 'learned' });
      toast(item.status === 'learned' ? '「まだ」に戻しました' : '「覚えた」にしました');
      practice.stale = true;
      renderList();
    }
    if (act === 'delete') {
      if (pendingDelete !== id) { pendingDelete = id; renderList(); return; }
      pendingDelete = null;
      store.update(id, { deleted: true });
      if (form.editingId === id) resetForm();
      practice.stale = true;
      toast('削除しました');
      renderList();
    }
  });

  // ---------------- まとめて登録 ----------------
  const GPT_PROMPT = [
    'これまでの会話(または下に貼った内容)から、私が復習すべき英単語と英文を選び、次のJSON形式「だけ」で出力してください。前置きや説明は書かないでください。',
    '',
    '{"items":[{"type":"word","en":"英語","ja":"日本語訳","example":"例文(任意)","note":"メモ(任意)"}]}',
    '',
    '・type は単語なら "word"、英文なら "sentence"',
    '・en と ja は必ず入れる。example と note は不要なら省略してよい',
    '・文中の改行は \\n、ダブルクォーテーションは \\" と書く',
    '・コードブロック(```json)で囲んで出力する',
  ].join('\n');
  const SAMPLE = JSON.stringify({
    items: [
      { type: 'word', en: 'postpone', ja: '延期する', example: "Let's postpone the meeting until Friday.", note: 'put off とほぼ同じ意味' },
      { type: 'sentence', en: "I'm looking forward to seeing you.", ja: 'あなたに会えるのを楽しみにしています。', note: 'to の後ろは -ing' },
      { type: 'sentence', en: 'Could you say that again, please?', ja: 'もう一度言っていただけますか?' },
    ],
  }, null, 2);
  $('gpt-prompt').textContent = GPT_PROMPT;
  $('bulk-sample').textContent = SAMPLE;
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    copyText($(b.dataset.copy).textContent, 'コピーしました');
  }));
  $('bulk-use-sample').addEventListener('click', () => { $('bulk-text').value = SAMPLE; $('bulk-text').focus(); });
  $('bulk-clear').addEventListener('click', () => { $('bulk-text').value = ''; closePreview(); $('bulk-error').hidden = true; });

  let bulkRows = [];
  $('bulk-parse').addEventListener('click', () => {
    const res = C.parseBulk($('bulk-text').value);
    const errBox = $('bulk-error');
    errBox.textContent = '';
    if (!res.ok) {
      closePreview();
      errBox.append(el('strong', { text: '読み取れませんでした' }), el('span', { text: res.error.message }));
      if (res.error.hint) errBox.append(el('span', { text: res.error.hint }));
      errBox.append(el('span', { class: 'small', text: 'ChatGPTに「さっきの内容を、指定したJSON形式だけで出し直して」と頼むと直ることが多いです。' }));
      errBox.hidden = false;
      errBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    errBox.hidden = true;
    bulkRows = res.rows;
    C.validateRows(bulkRows, store.all());
    bulkRows.forEach((r) => { r.selected = !r.hasError && !r.isDup; });
    renderPreview();
    $('bulk-preview-panel').hidden = false;
    $('bulk-input-panel').hidden = true;
    window.scrollTo(0, 0);
  });

  function closePreview() {
    bulkRows = [];
    $('bulk-preview-panel').hidden = true;
    $('bulk-input-panel').hidden = false;
  }
  $('bulk-cancel').addEventListener('click', closePreview);
  $('bulk-select-all').addEventListener('click', () => { bulkRows.forEach((r) => { r.selected = !r.hasError && !r.isDup; }); renderPreview(); });
  $('bulk-select-none').addEventListener('click', () => { bulkRows.forEach((r) => { r.selected = false; }); renderPreview(); });

  function revalidate() {
    C.validateRows(bulkRows, store.all());
    bulkRows.forEach((r) => { if (r.hasError) r.selected = false; });
  }

  function renderPreview() {
    const box = $('bulk-preview');
    box.textContent = '';
    bulkRows.forEach((r, i) => box.append(previewItem(r, i)));
    updateBulkSummary();
  }
  function issuesEl(r) {
    const wrap = el('div', { class: 'issues' });
    r.issues.forEach((x) => wrap.append(el('span', { class: 'chip ' + (x.level === 'error' ? 'bad' : 'warn'), text: x.text })));
    if (!r.issues.length) wrap.append(el('span', { class: 'chip good', text: '登録できます' }));
    return wrap;
  }
  function previewItem(r, i) {
    const item = el('div', { class: 'prev-item' + (r.selected ? '' : ' off'), dataset: { i: String(i) } });
    const cb = el('input', { type: 'checkbox', 'aria-label': r.index + '件目を登録する', checked: r.selected, disabled: r.hasError });
    const kindSel = el('select', { 'aria-label': '種類' }, [
      el('option', { value: 'word', text: '単語', selected: r.kind === 'word' }),
      el('option', { value: 'sentence', text: 'センテンス', selected: r.kind === 'sentence' }),
    ]);
    const issues = issuesEl(r);
    const en = el('input', { type: 'text', value: r.en, 'aria-label': '英語', placeholder: '英語(必須)', class: 'en-text' });
    const ja = el('input', { type: 'text', value: r.ja, 'aria-label': '日本語訳', placeholder: '日本語訳(必須)' });
    const ex = el('textarea', { 'aria-label': '例文', placeholder: '例文(任意)' }); ex.value = r.example;
    const note = el('textarea', { 'aria-label': 'メモ', placeholder: 'メモ(任意)' }); note.value = r.note;
    const refresh = () => {
      revalidate();
      // 全行の重複表示が変わりうるので、表示だけ更新する(入力中の欄はそのまま)
      document.querySelectorAll('#bulk-preview .prev-item').forEach((node) => {
        const row = bulkRows[Number(node.dataset.i)];
        node.querySelector('.issues').replaceWith(issuesEl(row));
        const c = node.querySelector('input[type="checkbox"]');
        c.disabled = row.hasError;
        c.checked = row.selected;
        node.classList.toggle('off', !row.selected);
      });
      updateBulkSummary();
    };
    cb.addEventListener('change', () => { r.selected = cb.checked; item.classList.toggle('off', !r.selected); updateBulkSummary(); });
    kindSel.addEventListener('change', () => { r.kind = kindSel.value; r.kindNote = null; refresh(); });
    en.addEventListener('input', () => { r.en = en.value.trim(); refresh(); });
    ja.addEventListener('input', () => { r.ja = ja.value.trim(); refresh(); });
    ex.addEventListener('input', () => { r.example = ex.value.trim(); });
    note.addEventListener('input', () => { r.note = note.value.trim(); });
    item.append(
      el('div', { class: 'head' }, [cb, el('span', { class: 'muted small', text: r.index + '件目' }), kindSel]),
      issues,
      el('div', { class: 'grid2' }, [
        el('label', { class: 'field' }, [el('span', { text: '英語' }), en]),
        el('label', { class: 'field' }, [el('span', { text: '日本語訳' }), ja]),
        el('label', { class: 'field' }, [el('span', { text: '例文(任意)' }), ex]),
        el('label', { class: 'field' }, [el('span', { text: 'メモ(任意)' }), note]),
      ])
    );
    return item;
  }
  function updateBulkSummary() {
    const sel = bulkRows.filter((r) => r.selected).length;
    const err = bulkRows.filter((r) => r.hasError).length;
    const dup = bulkRows.filter((r) => r.isDup).length;
    $('bulk-count').textContent = bulkRows.length + '件';
    const parts = ['選択中 ' + sel + '件'];
    if (err) parts.push('入力が足りない ' + err + '件(直すと選べます)');
    if (dup) parts.push('重複 ' + dup + '件(はじめは外してあります)');
    $('bulk-summary').textContent = parts.join(' / ');
    $('bulk-commit').textContent = '選んだ ' + sel + '件を登録';
    $('bulk-commit').disabled = sel === 0;
  }
  $('bulk-commit').addEventListener('click', () => {
    revalidate();
    const chosen = bulkRows.filter((r) => r.selected && !r.hasError);
    if (!chosen.length) { toast('登録するものを選んでください'); return; }
    const now = Date.now();
    const items = chosen.map((r, i) => C.makeItem({ kind: r.kind, en: r.en, ja: r.ja, example: r.example, note: r.note, source: 'bulk', createdAt: now + i }, now));
    store.addMany(items);
    practice.stale = true;
    toast(items.length + '件を登録しました');
    $('bulk-text').value = '';
    closePreview();
    const done = $('bulk-error');
    done.className = 'notice good';
    done.textContent = '';
    done.append(el('strong', { text: items.length + '件を登録しました' }), el('span', { text: '「練習」や「一覧」で確認できます。' }));
    done.hidden = false;
    setTimeout(() => { done.hidden = true; done.className = 'notice bad'; }, 6000);
  });

  // ---------------- 設定・バックアップ ----------------
  const downloadsWork = ENV !== 'artifact';
  $('backup-download').hidden = !downloadsWork;
  $('backup-copy').addEventListener('click', () => {
    const text = C.exportBackup(store.all());
    const out = $('backup-out');
    out.value = text;
    out.hidden = false;
    copyText(text, store.live().length + '件分のバックアップをコピーしました', out);
  });
  $('backup-download').addEventListener('click', () => {
    const blob = new Blob([C.exportBackup(store.all())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'eigo-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('restore-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => { $('restore-in').value = t; toast('読み込みました。「戻す」を押してください'); });
    e.target.value = '';
  });
  $('restore-run').addEventListener('click', () => {
    const res = C.parseBackup($('restore-in').value);
    if (!res.ok) { toast(res.error); return; }
    const merged = C.mergeBackup(store.all(), res.items);
    store.replaceAll(merged.items, 'local');
    practice.stale = true;
    $('restore-in').value = '';
    toast('追加 ' + merged.added + '件・更新 ' + merged.updated + '件・そのまま ' + merged.skipped + '件');
    renderSettings();
  });
  $('legacy-copy').addEventListener('click', () => copyText(lsGet(KEYS.legacyBackup) || '[]', '引き継ぐ前のデータをコピーしました'));

  function renderSettings() {
    const legacy = lsGet(KEYS.legacyBackup);
    $('legacy-panel').hidden = !legacy;
    if (legacy) {
      let n = 0;
      try { n = (JSON.parse(legacy) || []).length; } catch (e) {}
      $('legacy-text').textContent = '前の「センテンス暗記」のデータ(' + n + '件)を、引き継ぐ前の形のまま残してあります。新しいデータには影響しません。';
    }
    const all = store.live();
    const learned = all.filter((x) => x.status === 'learned').length;
    const unsynced = store.all().filter((x) => x.dirty).length;
    const stats = $('stats');
    stats.textContent = '';
    [['登録数', all.length + '件'], ['覚えた', learned + '件'], ['まだ', (all.length - learned) + '件'],
      ['保存先', storageOk ? 'この端末のブラウザ' : '保存できません(一時的)'],
      ['未同期', sync ? unsynced + '件' : '同期なし'],
    ].forEach(([k, v]) => stats.append(el('dt', { text: k }), el('dd', { text: v })));
    renderSyncArea();
  }

  // ---------------- 同期とChatGPT連携の表示(本体は sync.js) ----------------
  let sync = null;
  function renderSyncArea() {
    const area = $('sync-area');
    const gpt = $('gpt-area');
    if (sync) { sync.renderSettings(area, gpt); return; }
    area.textContent = '';
    gpt.textContent = '';
    if (ENV === 'artifact') {
      area.append(el('p', { class: 'muted small', text: 'このページ(Claudeの中で開く版)では同期は使えません。ホーム画面に追加する版(専用URL)で使えます。データは「バックアップを作る」→ 専用URL版の「バックアップから戻す」で移せます。' }));
      gpt.append(el('p', { class: 'muted small', text: '専用URL版で同期を設定したあとに使えるようになります。それまでは「まとめて」画面でChatGPTの回答を貼り付けて登録できます。' }));
    } else {
      area.append(el('p', { class: 'muted small', text: '同期の部品を読み込めませんでした。インターネットにつないでから、もう一度開いてください。' }));
    }
  }
  function setSyncChip(text, level) {
    const chip = $('sync-chip');
    chip.textContent = text;
    chip.className = 'chip' + (level ? ' ' + level : '');
  }

  // ---------------- 起動 ----------------
  const migrated = store.load();
  if (!storageOk) showStorageWarning();
  if (migrated && migrated.count > 0) {
    $('migrated-text').textContent = '前の「センテンス暗記」から' + migrated.count + '件を「センテンス」として引き継ぎました。前のデータもそのまま残してあります(設定画面からコピーできます)。';
    $('migrated-notice').hidden = false;
  }
  $('migrated-ok').addEventListener('click', () => { $('migrated-notice').hidden = true; });

  // 別のタブで変更されたら読み直す
  window.addEventListener('storage', (e) => {
    if (e.key === KEYS.items && e.newValue) {
      try { store.items = JSON.parse(e.newValue); } catch (err) { return; }
      practice.stale = true;
      refreshCurrent();
    }
  });
  store.subscribe((reason) => {
    if (reason === 'remote') { practice.stale = currentView !== 'practice' || practice.stale; refreshCurrent(); }
  });
  function refreshCurrent() {
    if (currentView === 'list') renderList();
    else if (currentView === 'settings') renderSettings();
    else if (currentView === 'practice') renderPractice();
  }

  syncSettingsUI();
  startPractice();

  window.EigoApp = {
    store, toast, el, copyText, ENV, setSyncChip,
    refresh: refreshCurrent,
    registerSync(api) { sync = api; if (currentView === 'settings') renderSettings(); },
    renderSettings,
  };
})();
