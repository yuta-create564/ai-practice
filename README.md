# ai-practice

## 英語暗記帳(sentence-app)

自分専用の英単語・英文の暗記アプリです。

- **練習**: 日本語を見て英語を思い浮かべ、タップで答え(英→日にも切り替え可)。答えのあと「覚えた / まだ」
- **出題設定**: 単語 / センテンス / 両方、全部 / まだのもの、登録順 / ランダム
- **登録**: 単語かセンテンスを選び、英語・日本語訳・例文・メモ。同じ内容は知らせます
- **まとめて**: ChatGPTの回答(JSON形式)を貼り付けて、確認・修正・選択してから一括登録
- **一覧**: 検索・絞り込み・編集・削除・「まだ」に戻す
- **設定**: バックアップの書き出し・復元、スマホとMacの同期、ChatGPT連携用キー

前の「センテンス暗記」のデータは、初めて開いたときに自動で引き継ぎます(元のデータも残します)。

### 準備と使い方
- [docs/SETUP.md](docs/SETUP.md) … ホーム画面アプリにする・スマホとMacで同期する
- [docs/CHATGPT.md](docs/CHATGPT.md) … ChatGPTから「単語帳に追加して」で登録する

### ファイル
| 場所 | 内容 |
|---|---|
| `sentence-app/` | アプリ本体(GitHub Pages で公開するフォルダ) |
| `supabase/schema.sql` | 同期先のデータベースの準備(SQL Editor に貼って実行) |
| `supabase/functions/eigo-api/` | ChatGPTからの登録を受け付ける窓口 |
| `tools/build-artifact.mjs` | Claudeの中で開く版(1ファイル)を作る |
| `tests/` | テスト |

### テスト
```sh
npm test                                   # データ処理と画面の動作(Chromium)
PGHOST=... PGPORT=... npm run test:db      # データベースの規則と登録窓口(ローカルのPostgres)
```
