/* 英語暗記帳: Supabase を使ったスマホとMacの同期、ChatGPT連携用キーの管理 */
(function () {
  'use strict';
  const App = window.EigoApp;
  const C = window.EigoCore;
  if (!App || App.ENV === 'artifact') return;
  const lib = window.supabase;
  if (!lib || !lib.createClient) return; // 部品が読めないときは「この端末に保存」のまま動く

  const el = App.el;
  const store = App.store;
  const CONF_KEY = 'eigo-app:sync-config';
  const STATE_KEY = 'eigo-app:sync-state';
  const SNAP_KEY = 'eigo-app:snapshot-before-first-sync';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function readJSON(k, f) { try { return JSON.parse(lsGet(k)) || f; } catch (e) { return f; } }

  function getConfig() {
    const fromFile = window.EIGO_CONFIG || {};
    const saved = readJSON(CONF_KEY, {});
    const url = (saved.supabaseUrl || fromFile.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = (saved.supabaseAnonKey || fromFile.supabaseAnonKey || '').trim();
    return url && key ? { url, key, fromFile: !saved.supabaseUrl } : null;
  }

  let client = null;
  let user = null;
  let state = { status: 'idle', message: '', lastSyncAt: null };
  let running = null;
  let again = false;
  let timer = null;

  function syncState() { return readJSON(STATE_KEY, {}); }
  function saveSyncState(s) { lsSet(STATE_KEY, JSON.stringify(s)); }

  function setStatus(status, message) {
    state.status = status;
    state.message = message || '';
    if (status === 'ok') state.lastSyncAt = Date.now();
    const unsynced = store.all().filter((x) => x.dirty).length;
    if (!client) App.setSyncChip('この端末に保存', '');
    else if (!user) App.setSyncChip('同期: 未ログイン', 'warn');
    else if (status === 'running') App.setSyncChip('同期中…', '');
    else if (status === 'error') App.setSyncChip('同期できていません', 'bad');
    else if (!navigator.onLine) App.setSyncChip('オフライン(' + unsynced + '件 未送信)', 'warn');
    else if (unsynced) App.setSyncChip(unsynced + '件 未送信', 'warn');
    else App.setSyncChip('同期済み', 'good');
    App.refresh && document.querySelector('#view-settings.active') && App.renderSettings();
  }

  function init() {
    const conf = getConfig();
    client = null; user = null;
    if (!conf) { setStatus('idle'); return; }
    try {
      client = lib.createClient(conf.url, conf.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'eigo-app:auth' } });
    } catch (e) {
      client = null;
      setStatus('error', '同期の設定が正しくありません: ' + e.message);
      return;
    }
    client.auth.getSession().then(({ data }) => {
      user = data && data.session ? data.session.user : null;
      setStatus('idle');
      if (user) syncNow();
    });
    client.auth.onAuthStateChange((_evt, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      if (user && user.id !== was) syncNow();
      setStatus(state.status === 'running' ? 'idle' : state.status, state.message);
    });
  }

  // ---------- 同期本体 ----------
  // 1) サーバーで変わったものを受け取る → 2) この端末で変わったものを送る
  // どちらも「新しく変更したほう」を残す。失敗しても端末のデータは消さない。
  async function doSync() {
    if (!client || !user) return;
    const st = syncState();
    if (st.owner && st.owner !== user.id) {
      throw new Error('この端末には別のアカウントで同期したデータがあります。混ざらないように同期を止めています。');
    }
    if (!st.owner) {
      // 初めての同期の前に、念のため今のデータを残しておく
      if (lsGet(SNAP_KEY) == null) lsSet(SNAP_KEY, C.exportBackup(store.all()));
    }

    // 受け取る(取りこぼしがないよう、前回より少し前から取り直す)
    let cursor = st.cursor ? new Date(new Date(st.cursor).getTime() - 60000).toISOString() : '1970-01-01T00:00:00Z';
    let maxSeen = st.cursor || null;
    for (let page = 0; page < 50; page++) {
      const { data, error } = await client.from('items').select('*')
        .gt('server_updated_at', cursor).order('server_updated_at', { ascending: true }).limit(500);
      if (error) throw error;
      if (!data.length) break;
      const merged = C.mergeRemote(store.all(), data);
      if (merged.changed) store.replaceAll(merged.items, 'remote');
      else store.replaceAll(merged.items, 'quiet');
      cursor = data[data.length - 1].server_updated_at;
      if (!maxSeen || cursor > maxSeen) maxSeen = cursor;
      if (data.length < 500) break;
    }

    // 送る
    for (let round = 0; round < 20; round++) {
      const dirty = store.all().filter((x) => x.dirty).slice(0, 200);
      if (!dirty.length) break;
      const { data, error } = await client.rpc('eigo_push', { p_items: dirty.map(C.toRow) });
      if (error) throw error;
      const merged = C.mergeRemote(store.all(), data || []);
      store.replaceAll(C.markPushed(merged.items, dirty), merged.changed ? 'remote' : 'quiet');
      // 送ったのに印が外れないもの(サーバー側で拒否された等)が続くときは止める
      const stuck = store.all().filter((x) => x.dirty && dirty.some((d) => d.id === x.id && d.updatedAt === x.updatedAt));
      if (stuck.length) throw new Error(stuck.length + '件を送れませんでした。内容に問題がないか確認してください。');
    }
    saveSyncState({ owner: user.id, cursor: maxSeen, lastSyncAt: Date.now() });
  }

  function syncNow() {
    if (!client || !user) return Promise.resolve();
    if (running) { again = true; return running; }
    if (!navigator.onLine) { setStatus('idle'); return Promise.resolve(); }
    setStatus('running');
    running = doSync().then(
      () => setStatus('ok'),
      (e) => setStatus('error', friendly(e))
    ).finally(() => {
      running = null;
      if (again) { again = false; schedule(500); }
    });
    return running;
  }
  function friendly(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'インターネットにつながりませんでした。端末内のデータはそのままです。つながったら自動でやり直します。';
    if (/JWT|token|session/i.test(m)) return 'ログインの期限が切れました。もう一度ログインしてください。端末内のデータはそのままです。';
    if (/relation .* does not exist|function .* does not exist|schema cache/i.test(m)) return 'Supabaseの準備(SQLの実行)がまだのようです。手順書の「データベースの準備」を行ってください。';
    return m + '(端末内のデータはそのままです)';
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(syncNow, ms); }

  store.subscribe((reason) => { if (reason === 'local') { setStatus(state.status === 'error' ? 'error' : 'idle', state.message); schedule(1500); } });
  window.addEventListener('online', () => schedule(300));
  window.addEventListener('offline', () => setStatus('idle'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);

  // ---------- 設定画面 ----------
  let newKey = null; // 作った直後だけ表示する(保存しない)
  let keyList = null;
  let pingResult = null;

  function renderSettings(area, gptArea) {
    area.textContent = '';
    const conf = getConfig();
    if (!conf) { area.append(configForm()); renderGpt(gptArea); return; }
    if (!user) { area.append(loginForm(conf)); renderGpt(gptArea); return; }

    const st = syncState();
    const unsynced = store.all().filter((x) => x.dirty).length;
    const box = el('div', { style: 'display:grid;gap:10px' });
    const level = state.status === 'error' ? 'bad' : unsynced ? 'warn' : 'good';
    box.append(el('div', { class: 'notice ' + level }, [
      el('strong', { text: state.status === 'error' ? '同期できていません' : state.status === 'running' ? '同期しています…' : unsynced ? unsynced + '件がまだ送られていません' : '同期済みです' }),
      el('span', { text: state.message || (st.lastSyncAt ? '最後に同期: ' + new Date(st.lastSyncAt).toLocaleString('ja-JP') : 'まだ同期していません') }),
    ]));
    box.append(el('dl', { class: 'kv' }, [
      el('dt', { text: 'ログイン中' }), el('dd', { text: user.email || user.id }),
      el('dt', { text: '同期先' }), el('dd', { text: conf.url.replace(/^https:\/\//, '') }),
    ]));
    box.append(el('div', { class: 'row' }, [
      el('button', { class: 'btn soft', type: 'button', text: '今すぐ同期', onclick: () => syncNow() }),
      el('button', { class: 'btn plain', type: 'button', text: 'ログアウト', onclick: async () => {
        await client.auth.signOut();
        App.toast('ログアウトしました。この端末のデータは残っています');
      } }),
    ]));
    if (lsGet(SNAP_KEY)) {
      box.append(el('button', { class: 'btn sm plain', type: 'button', text: '初めて同期する前のデータをコピー', onclick: () => App.copyText(lsGet(SNAP_KEY), 'コピーしました') }));
    }
    if (st.owner && st.owner !== user.id) {
      box.append(el('div', { class: 'notice warn' }, [
        el('span', { text: 'この端末のデータは別のアカウントで同期していたものです。バックアップを作ってから下のボタンを押すと、今のアカウントに送ります。' }),
        el('button', { class: 'btn sm soft', type: 'button', text: 'このアカウントで同期する', onclick: () => { saveSyncState({}); syncNow(); } }),
      ]));
    }
    area.append(box);
    renderGpt(gptArea);
  }

  function configForm() {
    const url = el('input', { type: 'url', id: 'cfg-url', placeholder: 'https://xxxx.supabase.co', autocomplete: 'off', inputmode: 'url' });
    const key = el('input', { type: 'text', id: 'cfg-key', placeholder: 'sb_publishable_... または eyJ...', autocomplete: 'off' });
    return el('div', { style: 'display:grid;gap:10px' }, [
      el('p', { class: 'muted small', text: '同期には無料の Supabase アカウントが必要です。手順書(SETUP.md)の「同期の準備」で作った「Project URL」と「公開用キー(Publishable key / anon key)」を入れてください。公開用キーは他人に見られても大丈夫なキーです(データは本人しか読めない設定にしてあります)。秘密のキー(secret / service_role)はここに入れないでください。' }),
      el('label', { class: 'field' }, [el('span', { text: 'Project URL' }), url]),
      el('label', { class: 'field' }, [el('span', { text: '公開用キー' }), key]),
      el('button', { class: 'btn', type: 'button', text: '保存する', onclick: () => {
        const u = url.value.trim(), k = key.value.trim();
        if (!/^https:\/\/[^/]+$/.test(u.replace(/\/+$/, ''))) { App.toast('Project URL は https:// から始まる形で入れてください'); return; }
        if (/service_role|sb_secret_/.test(k) || /"role"\s*:\s*"service_role"/.test(safeJwtPayload(k))) { App.toast('それは秘密のキーです。公開用キーを入れてください'); return; }
        if (k.length < 20) { App.toast('公開用キーが短すぎます'); return; }
        lsSet(CONF_KEY, JSON.stringify({ supabaseUrl: u, supabaseAnonKey: k }));
        init();
        App.renderSettings();
      } }),
    ]);
  }
  function safeJwtPayload(k) {
    try { return atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { return ''; }
  }

  function loginForm(conf) {
    const email = el('input', { type: 'email', id: 'login-email', placeholder: 'メールアドレス', autocomplete: 'username' });
    const pass = el('input', { type: 'password', id: 'login-pass', placeholder: 'パスワード(8文字以上)', autocomplete: 'current-password' });
    const msg = el('div', { class: 'notice info', hidden: true });
    const show = (level, text) => { msg.className = 'notice ' + level; msg.textContent = text; msg.hidden = false; };
    const go = async (mode) => {
      const e = email.value.trim(), p = pass.value;
      if (!e || p.length < 8) { show('warn', 'メールアドレスと8文字以上のパスワードを入れてください。'); return; }
      show('info', '確認しています…');
      try {
        if (mode === 'signup') {
          const { data, error } = await client.auth.signUp({ email: e, password: p });
          if (error) throw error;
          if (!data.session) show('good', '確認メールを送りました。メールのリンクを押してから、ここで「ログイン」を押してください。');
        } else {
          const { error } = await client.auth.signInWithPassword({ email: e, password: p });
          if (error) throw error;
          App.toast('ログインしました');
        }
      } catch (err) {
        const m = err.message || String(err);
        if (/Invalid login/i.test(m)) show('bad', 'メールアドレスかパスワードが違います。');
        else if (/not confirmed/i.test(m)) show('warn', 'メールの確認がまだです。届いたメールのリンクを押してください。');
        else if (/Signups not allowed|signup.*disabled/i.test(m)) show('bad', '新しいアカウントは作れない設定になっています(自分専用にするための設定です)。');
        else show('bad', friendly(err));
      }
    };
    return el('div', { style: 'display:grid;gap:10px' }, [
      el('p', { class: 'muted small', text: 'スマホとMacで同じメールアドレスでログインすると、同じデータを使えます。ログインしても、この端末のデータは消えません(足りないものを送り合います)。' }),
      email, pass, msg,
      el('div', { class: 'row' }, [
        el('button', { class: 'btn plain', type: 'button', text: '初めて使う(アカウント作成)', onclick: () => go('signup') }),
        el('button', { class: 'btn', type: 'button', text: 'ログイン', onclick: () => go('login') }),
      ]),
      el('button', { class: 'btn sm plain', type: 'button', text: '同期先の設定をやり直す', onclick: () => { lsDel(CONF_KEY); init(); App.renderSettings(); } }),
      el('p', { class: 'muted small', text: '同期先: ' + conf.url.replace(/^https:\/\//, '') }),
    ]);
  }

  // ---------- ChatGPT 連携 ----------
  function apiBase() { const c = getConfig(); return c ? c.url + '/functions/v1/eigo-api' : ''; }

  function randomKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const out = [];
    const buf = new Uint32Array(40);
    crypto.getRandomValues(buf);
    for (let i = 0; i < 40; i++) out.push(chars[buf[i] % chars.length]);
    return 'eigo_' + out.join('');
  }
  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function loadKeys() {
    const { data, error } = await client.from('api_keys').select('id,label,created_at,last_used_at,revoked_at').order('created_at', { ascending: false });
    keyList = error ? { error: friendly(error) } : data;
    App.renderSettings();
  }

  function renderGpt(area) {
    area.textContent = '';
    if (!client || !user) {
      area.append(el('p', { class: 'muted small', text: '同期の設定とログインが終わると、ここでChatGPT連携の準備ができます。それまでは「まとめて」画面でChatGPTの回答を貼り付けて登録できます。' }));
      return;
    }
    if (keyList == null) { keyList = []; loadKeys(); }
    area.append(el('p', { class: 'muted small', text: 'ChatGPTで自分専用のGPTを作り、ここで作るキーを設定すると、「この単語を単語帳に追加して」と頼むだけで登録できるようになります。手順は CHATGPT.md を見てください。キーは他の人に見せないでください。' }));

    if (newKey) {
      area.append(el('div', { class: 'notice warn' }, [
        el('strong', { text: '新しいキー(この画面を離れると二度と表示されません)' }),
        el('code', { class: 'inline', id: 'new-key', text: newKey }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn sm soft', type: 'button', text: 'キーをコピー', onclick: () => App.copyText(newKey, 'キーをコピーしました') }),
          el('button', { class: 'btn sm plain', type: 'button', text: '接続テスト', onclick: ping }),
        ]),
        pingResult ? el('span', { text: pingResult }) : null,
      ]));
    }
    area.append(el('button', { class: 'btn soft', type: 'button', text: '連携用キーを作る', onclick: createKey }));

    if (Array.isArray(keyList) && keyList.length) {
      const ul = el('ul', { class: 'items' });
      keyList.forEach((k) => {
        ul.append(el('li', {}, [
          el('div', { class: 'row', style: 'gap:6px' }, [
            el('b', { text: k.label }),
            k.revoked_at ? el('span', { class: 'chip', text: '無効' }) : el('span', { class: 'chip good', text: '有効' }),
          ]),
          el('div', { class: 'muted small', text: '作成: ' + new Date(k.created_at).toLocaleString('ja-JP') + (k.last_used_at ? ' / 最後に使用: ' + new Date(k.last_used_at).toLocaleString('ja-JP') : ' / まだ使われていません') }),
          k.revoked_at ? null : el('div', { class: 'actions' }, [
            el('button', { class: 'btn sm bad', type: 'button', text: '無効にする', onclick: async () => {
              const { error } = await client.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', k.id);
              App.toast(error ? friendly(error) : 'キーを無効にしました');
              loadKeys();
            } }),
          ]),
        ]));
      });
      area.append(ul);
    } else if (keyList && keyList.error) {
      area.append(el('p', { class: 'muted small', text: keyList.error }));
    }

    area.append(
      el('details', {}, [
        el('summary', {}, [el('b', { text: 'GPTに設定する内容(コピー用)' })]),
        el('div', { style: 'display:grid;gap:8px;margin-top:8px' }, [
          el('p', { class: 'muted small', text: '① 指示(Instructions)' }),
          el('pre', { class: 'sample', style: 'white-space:pre-wrap', id: 'gpt-instructions', text: gptInstructions() }),
          el('button', { class: 'btn sm soft', type: 'button', text: '指示をコピー', onclick: () => App.copyText(gptInstructions(), '指示をコピーしました') }),
          el('p', { class: 'muted small', text: '② アクションのスキーマ(Schema)' }),
          el('pre', { class: 'sample', id: 'gpt-schema', text: openApi(apiBase()) }),
          el('button', { class: 'btn sm soft', type: 'button', text: 'スキーマをコピー', onclick: () => App.copyText(openApi(apiBase()), 'スキーマをコピーしました') }),
          el('p', { class: 'muted small', text: '③ 認証(Authentication): 「APIキー」→ 種類「Bearer」→ 上で作ったキーを貼り付け' }),
        ]),
      ])
    );
  }

  async function createKey() {
    const key = randomKey();
    const hash = await sha256Hex(key);
    const label = 'ChatGPT ' + new Date().toLocaleDateString('ja-JP');
    const { error } = await client.from('api_keys').insert({ key_hash: hash, label });
    if (error) { App.toast(friendly(error)); return; }
    newKey = key;
    pingResult = null;
    App.toast('キーを作りました。コピーしてGPTの設定に貼ってください');
    loadKeys();
  }
  async function ping() {
    pingResult = '確認しています…';
    App.renderSettings();
    try {
      const res = await fetch(apiBase() + '/ping', { headers: { Authorization: 'Bearer ' + newKey } });
      const body = await res.json().catch(() => ({}));
      if (res.ok) pingResult = '接続テスト成功: 登録用の窓口(Edge Function)とキーは正しく動いています。次はGPT側の設定です。';
      else if (res.status === 404) pingResult = '登録用の窓口がまだ公開されていません(手順書の「ChatGPT連携の窓口を作る」)。';
      else pingResult = '接続テスト失敗(' + res.status + '): ' + (body.message || body.error || '');
    } catch (e) {
      pingResult = '接続テスト失敗: 登録用の窓口(Edge Function)がまだ公開されていないか、ネットにつながっていません。';
    }
    App.renderSettings();
  }

  function gptInstructions() {
    return [
      'あなたは私の英語学習アシスタントです。私の「英語暗記帳」アプリに単語やセンテンスを登録できます。',
      '',
      '登録のルール:',
      '1. 私が「単語帳に追加して」「センテンス帳に追加して」など、はっきり登録を頼んだときだけ addItems を使う。頼まれていないのに登録しない。',
      '2. 「今日の会話から復習候補を出して」と言われたら、私が渡した内容や、この会話で私が示した範囲だけから候補を番号付きで出し、どれを登録するか私に選んでもらう。選ばれたものだけ登録する。',
      '3. 登録する前に、種類(単語=word / センテンス=sentence)、英語、日本語訳を一覧で見せる。',
      '4. type は単語なら "word"、英文なら "sentence"。en と ja は必須。例文(example)とメモ(note)は役に立つときだけ短く入れる。',
      '5. request_id には依頼ごとに新しいランダムな文字列を入れる。同じ依頼を再送するときは同じ request_id を使う。',
      '6. 結果の summary を伝え、duplicates(登録済み)や errors があれば内容を説明する。',
      '7. 登録する単語・英文以外の会話内容や個人情報は送らない。',
      '8. 「登録済みか調べて」と言われたら searchItems を使う。',
    ].join('\n');
  }

  function openApi(base) {
    const item = {
      type: 'object',
      required: ['type', 'en', 'ja'],
      properties: {
        type: { type: 'string', enum: ['word', 'sentence'], description: '単語なら word、英文なら sentence' },
        en: { type: 'string', description: '英語', maxLength: 1000 },
        ja: { type: 'string', description: '日本語訳', maxLength: 1000 },
        example: { type: 'string', description: '例文(任意)', maxLength: 2000 },
        note: { type: 'string', description: 'メモ(任意)', maxLength: 2000 },
      },
    };
    return JSON.stringify({
      openapi: '3.1.0',
      info: { title: '英語暗記帳', version: '1.0.0', description: '自分専用の英語暗記帳に単語・センテンスを登録する' },
      servers: [{ url: base || 'https://YOUR-PROJECT.supabase.co/functions/v1/eigo-api' }],
      paths: {
        '/items': {
          post: {
            operationId: 'addItems',
            summary: '単語・センテンスを登録する(重複は自動で除外)',
            'x-openai-isConsequential': true,
            requestBody: {
              required: true,
              content: { 'application/json': { schema: {
                type: 'object', required: ['request_id', 'items'],
                properties: {
                  request_id: { type: 'string', description: '依頼ごとのランダムな文字列。再送時は同じ値' },
                  items: { type: 'array', minItems: 1, maxItems: 50, items: item },
                },
              } } },
            },
            responses: { 200: { description: '登録結果(added, duplicates, errors, summary)' } },
          },
          get: {
            operationId: 'searchItems',
            summary: '登録済みか調べる',
            'x-openai-isConsequential': false,
            parameters: [
              { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: '英語または日本語の一部' },
              { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50 } },
            ],
            responses: { 200: { description: '見つかった項目' } },
          },
        },
      },
      components: { schemas: {}, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
    }, null, 2);
  }

  init();
  App.registerSync({ renderSettings, syncNow, openApi, gptInstructions });
})();
