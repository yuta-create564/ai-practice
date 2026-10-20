-- supabase/schema.sql のテスト。失敗すると例外で止まる。
\set ON_ERROR_STOP on
insert into auth.users values ('aaaaaaaa-0000-4000-8000-000000000001'), ('bbbbbbbb-0000-4000-8000-000000000002');

create function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;
grant execute on function pg_temp.ok(boolean, text) to public;

select pg_temp.ok(public.eigo_normalize('See  you later.') = public.eigo_normalize('see you later'), '重複判定: 大文字・空白・文末記号を無視');
select pg_temp.ok(public.eigo_normalize('I’m fine!') = public.eigo_normalize('i''m fine'), '重複判定: 引用符の違いを無視');

-- ===== ユーザーA =====
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', false);
select pg_temp.ok((select count(*) from public.eigo_push('[
  {"id":"11111111-0000-4000-8000-000000000001","kind":"word","en":"postpone","ja":"延期する","status":"learning","created_at_ms":1000,"updated_at_ms":1000},
  {"id":"11111111-0000-4000-8000-000000000002","kind":"sentence","en":"See you.","ja":"またね","example":"line1\nline2 \"quoted\"","created_at_ms":1001,"updated_at_ms":1001}
]'::jsonb)) = 2, 'Aが2件送信できる');
select pg_temp.ok((select example from public.items where id='11111111-0000-4000-8000-000000000002') = E'line1\nline2 "quoted"', '改行と記号がそのまま保存される');

-- 新しい変更は反映され、古い変更は無視される
select count(*) from public.eigo_push('[{"id":"11111111-0000-4000-8000-000000000001","kind":"word","en":"postpone","ja":"延期する","status":"learned","created_at_ms":1000,"updated_at_ms":2000}]');
select pg_temp.ok((select status from public.items where id='11111111-0000-4000-8000-000000000001') = 'learned', '新しい変更は反映される');
select pg_temp.ok((select status from public.eigo_push('[{"id":"11111111-0000-4000-8000-000000000001","kind":"word","en":"postpone","ja":"古い訳","status":"learning","created_at_ms":1000,"updated_at_ms":1500}]')) = 'learned', '古い変更では上書きされず、サーバーの内容が返る');
select pg_temp.ok((select ja from public.items where id='11111111-0000-4000-8000-000000000001') = '延期する', '古い訳で上書きされていない');

-- 行の削除は不可(削除は印で行う)
do $$ begin
  delete from public.items;
  raise exception 'FAIL: 削除できてしまった';
exception when insufficient_privilege then raise notice 'ok: 行の削除はできない';
end $$;
-- ChatGPT用の関数はアプリから呼べない
do $$ begin
  perform public.eigo_api_add(repeat('a',64), 'x', '[]');
  raise exception 'FAIL: authenticated が eigo_api_add を呼べた';
exception when insufficient_privilege then raise notice 'ok: アプリから ChatGPT 用の関数は呼べない';
end $$;
-- キー登録(ハッシュのみ)
insert into public.api_keys (key_hash) values (repeat('a', 64));
select pg_temp.ok((select count(*) from public.api_keys) = 1, 'Aは自分のキーを登録できる');

-- ===== ユーザーB =====
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', false);
select pg_temp.ok((select count(*) from public.items) = 0, 'BからAのデータは見えない');
select pg_temp.ok((select count(*) from public.api_keys) = 0, 'BからAのキーは見えない');
do $$ begin
  perform * from public.eigo_push('[{"id":"11111111-0000-4000-8000-000000000001","kind":"word","en":"hacked","ja":"x","created_at_ms":1,"updated_at_ms":999999}]');
  raise notice 'ok: BがAの行を送っても反映されない(下で確認)';
exception when others then raise notice 'ok: BがAの行を書き換えようとするとエラー (%)', sqlerrm;
end $$;
do $$ begin
  insert into public.items (id, user_id, kind, en, ja, created_at_ms, updated_at_ms)
  values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000001', 'word', 'x', 'x', 1, 1);
  raise exception 'FAIL: BがAとして行を作れた';
exception when insufficient_privilege then raise notice 'ok: BはAの名前で行を作れない';
end $$;
do $$ begin
  update public.api_keys set revoked_at = now();
  update public.items set ja = 'hacked';
end $$;
reset role;
select pg_temp.ok((select en from public.items where id='11111111-0000-4000-8000-000000000001') = 'postpone', 'Aの行はBに変えられていない');
select pg_temp.ok((select revoked_at is null from public.api_keys limit 1), 'AのキーはBに無効化されていない');

-- ===== 未ログイン =====
set role anon;
do $$ begin
  perform * from public.items;
  raise exception 'FAIL: 未ログインで読めた';
exception when insufficient_privilege then raise notice 'ok: 未ログインでは読めない';
end $$;
reset role;

-- ===== ChatGPT 経由(Edge Function = service_role) =====
set role service_role;
select pg_temp.ok(public.eigo_api_add(repeat('b',64), 'r0', '[{"type":"word","en":"x","ja":"y"}]') ->> 'error' = 'invalid_key', '知らないキーは拒否');
create temp table r as select public.eigo_api_add(repeat('a',64), 'req-1', '[
  {"type":"word","en":"Postpone","ja":"延期する"},
  {"type":"sentence","en":"Could you say that again?","ja":"もう一度言ってもらえますか","note":"丁寧"},
  {"type":"sentence","en":"could you say that again","ja":"重複"},
  {"type":"phrase","en":"x","ja":"y"},
  {"type":"word","en":"","ja":"空"}
]') as resp;
select pg_temp.ok(jsonb_array_length((select resp->'added' from r)) = 1, 'ChatGPT: 新しい1件だけ追加');
select pg_temp.ok(jsonb_array_length((select resp->'duplicates' from r)) = 2, 'ChatGPT: 既存との重複・同じ依頼内の重複を検出');
select pg_temp.ok(jsonb_array_length((select resp->'errors' from r)) = 2, 'ChatGPT: 種類の誤り・必須項目不足を検出');
select pg_temp.ok((public.eigo_api_add(repeat('a',64), 'req-1', '[{"type":"word","en":"brand new","ja":"新"}]') ->> 'replayed')::boolean, '同じ依頼IDの再送は前回の結果を返す');
reset role;
select pg_temp.ok((select count(*) from public.items where user_id='aaaaaaaa-0000-4000-8000-000000000001') = 3, '再送で増えていない');
set role service_role;
select pg_temp.ok(jsonb_array_length(public.eigo_api_add(repeat('a',64), 'req-2', '[{"type":"sentence","en":"Could you say that again?","ja":"x"}]') -> 'added') = 0, '依頼IDが違っても同じ内容は追加しない');
reset role;
select pg_temp.ok((select source from public.items where en='Could you say that again?') = 'chatgpt', 'ChatGPT から来た印が付く');
set role service_role;
select pg_temp.ok(jsonb_array_length(public.eigo_api_search(repeat('a',64), 'again', 10) -> 'items') = 1, '検索は自分のデータから');
reset role;
-- キーを無効にすると使えない
update public.api_keys set revoked_at = now();
set role service_role;
select pg_temp.ok(public.eigo_api_add(repeat('a',64), 'req-3', '[{"type":"word","en":"z","ja":"z"}]') ->> 'error' = 'invalid_key', '無効にしたキーは使えない');
reset role;
-- サーバー側の変更時刻は進む(他の端末が差分を取れる)
select pg_temp.ok((select max(server_updated_at) > min(server_updated_at) from public.items), 'サーバーの変更時刻が付く');
\echo ALL SQL TESTS PASSED
