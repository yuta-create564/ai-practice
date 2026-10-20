-- 英語暗記帳: Supabase の SQL Editor に丸ごと貼り付けて「Run」を1回押すだけで準備できます。
-- 何度実行しても壊れないように書いてあります。

-- ===== 重複判定(アプリの core.js の normalizeKey と同じ規則) =====
create or replace function public.eigo_normalize(s text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           btrim(regexp_replace(
             translate(lower(normalize(coalesce(s, ''), NFKC)), '‘’`“”', '''''''""'),
             '\s+', ' ', 'g')),
           '[\s.!?。]+$', '')
$$;

-- ===== 単語・センテンス =====
create table if not exists public.items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('word', 'sentence')),
  en text not null check (char_length(en) between 1 and 1000),
  ja text not null check (char_length(ja) between 1 and 1000),
  example text not null default '' check (char_length(example) <= 2000),
  note text not null default '' check (char_length(note) <= 2000),
  status text not null default 'learning' check (status in ('learning', 'learned')),
  deleted boolean not null default false,
  source text not null default 'app',
  created_at_ms bigint not null,
  updated_at_ms bigint not null,
  server_updated_at timestamptz not null default now(),
  dedupe_key text generated always as (kind || '|' || public.eigo_normalize(en)) stored
);
create index if not exists items_user_sync on public.items (user_id, server_updated_at);
create index if not exists items_user_dedupe on public.items (user_id, dedupe_key) where not deleted;

-- サーバー側で変更時刻を付ける(他の端末が「ここから先の変更」を取りに来るときに使う)
create or replace function public.eigo_touch()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
  for each row execute function public.eigo_touch();

-- 本人のデータだけ読み書きできるようにする(他人のデータは見えない・変えられない)
alter table public.items enable row level security;
drop policy if exists "items_select_own" on public.items;
drop policy if exists "items_insert_own" on public.items;
drop policy if exists "items_update_own" on public.items;
create policy "items_select_own" on public.items for select to authenticated using (user_id = auth.uid());
create policy "items_insert_own" on public.items for insert to authenticated with check (user_id = auth.uid());
create policy "items_update_own" on public.items for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- 削除は「削除済み」の印で行うので、行そのものを消す権限は与えない

revoke all on public.items from anon, authenticated;
grant select, insert, update on public.items to authenticated;

-- 端末からの送信。サーバーのほうが新しいときは上書きしない。
-- 送った行の「今のサーバーの内容」を返すので、端末側はそれで揃えられる。
create or replace function public.eigo_push(p_items jsonb)
returns setof public.items
language plpgsql
security invoker
set search_path = public
as $$
declare
  r jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'p_items must be an array of at most 500 rows';
  end if;
  for r in select * from jsonb_array_elements(p_items) loop
    insert into public.items as t (id, user_id, kind, en, ja, example, note, status, deleted, source, created_at_ms, updated_at_ms)
    values (
      (r->>'id')::uuid, auth.uid(), r->>'kind', r->>'en', r->>'ja',
      coalesce(r->>'example', ''), coalesce(r->>'note', ''),
      coalesce(r->>'status', 'learning'), coalesce((r->>'deleted')::boolean, false),
      coalesce(r->>'source', 'app'), (r->>'created_at_ms')::bigint, (r->>'updated_at_ms')::bigint
    )
    on conflict (id) do update set
      kind = excluded.kind, en = excluded.en, ja = excluded.ja, example = excluded.example,
      note = excluded.note, status = excluded.status, deleted = excluded.deleted,
      updated_at_ms = excluded.updated_at_ms
    where t.user_id = auth.uid() and t.updated_at_ms < excluded.updated_at_ms;
  end loop;
  return query
    select * from public.items
    where user_id = auth.uid()
      and id in (select (e->>'id')::uuid from jsonb_array_elements(p_items) e);
end $$;
revoke all on function public.eigo_push(jsonb) from public, anon;
grant execute on function public.eigo_push(jsonb) to authenticated;

-- ===== ChatGPT 連携用のキー(キーそのものは保存せず、ハッシュだけ保存) =====
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  label text not null default 'ChatGPT' check (char_length(label) <= 60),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table public.api_keys enable row level security;
drop policy if exists "keys_select_own" on public.api_keys;
drop policy if exists "keys_insert_own" on public.api_keys;
drop policy if exists "keys_update_own" on public.api_keys;
create policy "keys_select_own" on public.api_keys for select to authenticated using (user_id = auth.uid());
create policy "keys_insert_own" on public.api_keys for insert to authenticated with check (user_id = auth.uid());
create policy "keys_update_own" on public.api_keys for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.api_keys from anon, authenticated;
grant select, insert on public.api_keys to authenticated;
grant update (revoked_at) on public.api_keys to authenticated;

-- 同じ依頼が再送されたときに同じ結果を返すための記録
create table if not exists public.api_requests (
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id text not null check (char_length(request_id) between 1 and 200),
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
alter table public.api_requests enable row level security;
revoke all on public.api_requests from anon, authenticated;

-- ChatGPT からの登録(Edge Function からだけ呼ぶ。アプリやブラウザからは呼べない)
create or replace function public.eigo_api_add(p_key_hash text, p_request_id text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_prev jsonb;
  r jsonb;
  v_kind text;
  v_en text;
  v_ja text;
  v_key text;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_i int := 0;
  v_added jsonb := '[]'::jsonb;
  v_dups jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  v_resp jsonb;
begin
  select user_id into v_user from public.api_keys
   where key_hash = p_key_hash and revoked_at is null;
  if v_user is null then
    return jsonb_build_object('error', 'invalid_key');
  end if;
  update public.api_keys set last_used_at = now() where key_hash = p_key_hash;

  -- 同じ人の登録は1件ずつ順番に処理する(同時に再送されても二重にならない)
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  if p_request_id is not null and p_request_id <> '' then
    select response into v_prev from public.api_requests where user_id = v_user and request_id = p_request_id;
    if v_prev is not null then
      return v_prev || jsonb_build_object('replayed', true);
    end if;
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('error', 'no_items');
  end if;
  if jsonb_array_length(p_items) > 50 then
    return jsonb_build_object('error', 'too_many_items');
  end if;

  for r in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    v_kind := lower(btrim(coalesce(r->>'type', r->>'kind', '')));
    v_en := btrim(coalesce(r->>'en', ''));
    v_ja := btrim(coalesce(r->>'ja', ''));
    if v_kind not in ('word', 'sentence') then
      v_errors := v_errors || jsonb_build_object('index', v_i, 'en', v_en, 'reason', 'type は "word" か "sentence" にしてください');
      continue;
    end if;
    if v_en = '' or v_ja = '' then
      v_errors := v_errors || jsonb_build_object('index', v_i, 'en', v_en, 'reason', '英語(en)と日本語訳(ja)は必須です');
      continue;
    end if;
    if char_length(v_en) > 1000 or char_length(v_ja) > 1000
       or char_length(coalesce(r->>'example', '')) > 2000 or char_length(coalesce(r->>'note', '')) > 2000 then
      v_errors := v_errors || jsonb_build_object('index', v_i, 'en', left(v_en, 80), 'reason', '文字数が多すぎます');
      continue;
    end if;
    v_key := v_kind || '|' || public.eigo_normalize(v_en);
    if v_key = any (v_seen) or exists (
      select 1 from public.items where user_id = v_user and dedupe_key = v_key and not deleted
    ) then
      v_dups := v_dups || jsonb_build_object('index', v_i, 'type', v_kind, 'en', v_en);
      continue;
    end if;
    v_seen := v_seen || v_key;
    insert into public.items (id, user_id, kind, en, ja, example, note, status, deleted, source, created_at_ms, updated_at_ms)
    values (gen_random_uuid(), v_user, v_kind, v_en, v_ja,
            btrim(coalesce(r->>'example', '')), btrim(coalesce(r->>'note', '')),
            'learning', false, 'chatgpt', v_now + v_i, v_now + v_i);
    v_added := v_added || jsonb_build_object('index', v_i, 'type', v_kind, 'en', v_en, 'ja', v_ja);
  end loop;

  v_resp := jsonb_build_object(
    'added', v_added, 'duplicates', v_dups, 'errors', v_errors,
    'summary', format('%s件を登録しました。重複 %s件、エラー %s件。', jsonb_array_length(v_added), jsonb_array_length(v_dups), jsonb_array_length(v_errors))
  );
  if p_request_id is not null and p_request_id <> '' then
    insert into public.api_requests (user_id, request_id, response) values (v_user, p_request_id, v_resp);
  end if;
  return v_resp;
end $$;
revoke all on function public.eigo_api_add(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.eigo_api_add(text, text, jsonb) to service_role;

-- ChatGPT から「登録済みか」を調べる(読むだけ)
create or replace function public.eigo_api_search(p_key_hash text, p_query text, p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.api_keys where key_hash = p_key_hash and revoked_at is null;
  if v_user is null then
    return jsonb_build_object('error', 'invalid_key');
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('type', kind, 'en', en, 'ja', ja, 'status', status) order by created_at_ms desc)
    from (
      select kind, en, ja, status, created_at_ms from public.items
      where user_id = v_user and not deleted
        and (coalesce(p_query, '') = '' or en ilike '%' || p_query || '%' or ja ilike '%' || p_query || '%')
      order by created_at_ms desc
      limit least(greatest(coalesce(p_limit, 20), 1), 50)
    ) s), '[]'::jsonb));
end $$;
revoke all on function public.eigo_api_search(text, text, int) from public, anon, authenticated;
grant execute on function public.eigo_api_search(text, text, int) to service_role;
