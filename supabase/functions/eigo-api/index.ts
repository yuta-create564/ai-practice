// 英語暗記帳: ChatGPT(GPTのアクション)から単語・センテンスを登録するための窓口。
// Supabase の Edge Function として公開する。秘密のキーはコードに書かず、Supabase が自動で渡す環境変数を使う。
//
//   POST /eigo-api/items   登録する   本文: {"request_id": "...", "items": [{"type":"word","en":"...","ja":"..."}]}
//   GET  /eigo-api/items?q=...         登録済みか調べる
//   GET  /eigo-api/ping                接続の確認
//
// 認証: ヘッダー「Authorization: Bearer eigo_...」(アプリの設定画面で作る本人専用のキー)

type Env = { url: string; serviceKey: string };

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function rpc(env: Env, fetchImpl: typeof fetch, fn: string, args: unknown): Promise<any> {
  const headers: Record<string, string> = { apikey: env.serviceKey, 'Content-Type': 'application/json' };
  // 旧形式の service_role キー(JWT)は Authorization にも入れる。新形式(sb_secret_)は apikey だけでよい。
  if (!env.serviceKey.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + env.serviceKey;
  const res = await fetchImpl(env.url.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error('database ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

const KEY_RE = /^eigo_[A-Za-z0-9]{40}$/;

export async function handle(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const route = path.endsWith('/items') ? 'items' : path.endsWith('/ping') ? 'ping' : null;
  if (!route) return json(404, { error: 'not_found', message: '/items か /ping を使ってください。' });

  const auth = req.headers.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  if (!KEY_RE.test(key)) {
    return json(401, { error: 'unauthorized', message: '連携用キーがありません。GPTの設定で「API キー / Bearer」にアプリで作ったキーを入れてください。' });
  }
  const keyHash = await sha256Hex(key);

  try {
    if (req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').slice(0, 200);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
      const out = await rpc(env, fetchImpl, 'eigo_api_search', { p_key_hash: keyHash, p_query: route === 'ping' ? '' : q, p_limit: route === 'ping' ? 1 : limit });
      if (out && out.error === 'invalid_key') return json(401, { error: 'invalid_key', message: 'キーが正しくないか、無効にされています。アプリで新しいキーを作ってください。' });
      if (route === 'ping') return json(200, { ok: true, message: '接続できました。' });
      return json(200, out);
    }
    if (req.method !== 'POST' || route !== 'items') return json(405, { error: 'method_not_allowed' });

    let body: any;
    try {
      body = await req.json();
    } catch (_e) {
      return json(400, { error: 'bad_json', message: '本文をJSONとして読めませんでした。' });
    }
    const items = Array.isArray(body) ? body : body && body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return json(400, { error: 'no_items', message: 'items に1件以上入れてください。' });
    }
    if (items.length > 50) return json(400, { error: 'too_many_items', message: '一度に登録できるのは50件までです。' });
    const requestId = String(req.headers.get('idempotency-key') || (body && body.request_id) || '').slice(0, 200);

    const out = await rpc(env, fetchImpl, 'eigo_api_add', { p_key_hash: keyHash, p_request_id: requestId || null, p_items: items });
    if (out && out.error === 'invalid_key') return json(401, { error: 'invalid_key', message: 'キーが正しくないか、無効にされています。アプリで新しいキーを作ってください。' });
    if (out && out.error) return json(400, out);
    return json(200, out);
  } catch (e) {
    console.error(e);
    return json(502, { error: 'server_error', message: '保存先に接続できませんでした。少し待ってからもう一度試してください。登録されたかどうかはアプリの一覧で確認できます。' });
  }
}

function readEnv(): Env {
  // @ts-ignore Deno はSupabase上でだけ存在する
  const get = (k: string) => Deno.env.get(k) || '';
  let serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) {
    try {
      const keys = JSON.parse(get('SUPABASE_SECRET_KEYS') || '{}');
      serviceKey = keys.default || Object.values(keys)[0] || '';
    } catch (_e) { /* なし */ }
  }
  return { url: get('SUPABASE_URL'), serviceKey: String(serviceKey) };
}

// @ts-ignore Supabase(Deno)の上で動くときだけサーバーを起動する
if (typeof Deno !== 'undefined' && Deno.serve) {
  // @ts-ignore
  Deno.serve((req: Request) => handle(req, readEnv()));
}
