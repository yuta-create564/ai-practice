// テスト用: Supabase の代わり。ブラウザ側の部品で、実際の保存は Node 側の fakeServer() が行う。
(function () {
  function result(p) { return p.then((r) => r); }
  function query(table) {
    const q = { table, filters: {} };
    const api = {
      select() { q.op = 'select'; return api; },
      gt(col, v) { q.gt = v; return api; },
      order() { return api; },
      limit(n) { q.limit = n; return api; },
      eq(col, v) { q.eq = v; return api; },
      insert(row) { q.op = 'insert'; q.row = row; return api; },
      update(row) { q.op = 'update'; q.row = row; return api; },
      then(res, rej) { return window.fakeServer(JSON.stringify(q)).then((s) => JSON.parse(s)).then(res, rej); },
    };
    return api;
  }
  let session = null;
  try { session = JSON.parse(localStorage.getItem('fake-session')); } catch (e) {}
  const cbs = [];
  window.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() { return { data: { session } }; },
          onAuthStateChange(cb) { cbs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithPassword({ email }) {
            session = { user: { id: 'user-1', email } };
            localStorage.setItem('fake-session', JSON.stringify(session));
            cbs.forEach((cb) => cb('SIGNED_IN', session));
            return { data: { session }, error: null };
          },
          async signUp() { return { data: { session: null }, error: null }; },
          async signOut() { session = null; localStorage.removeItem('fake-session'); cbs.forEach((cb) => cb('SIGNED_OUT', null)); return { error: null }; },
        },
        from: query,
        rpc(name, args) { return window.fakeServer(JSON.stringify({ op: 'rpc', name, args })).then((s) => JSON.parse(s)); },
      };
    },
  };
})();
