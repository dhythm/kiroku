# Kiroku — AI-powered Notes

思いつきを、次の一歩に。日本語中心の匿名メモ帳MVPです。メモCRUD、タイトル・本文の検索、タグ、Workers AIによるワンクリック要約を備えています。AIが未設定のときは明確に無効表示します。

## ローカルで起動

Node.js **24**（最低22.12）、npmを使用します。

```sh
npm ci
npm run db:local
npm run dev
```

`http://127.0.0.1:3000` を開いてください。D1は `.wrangler/state` に永続化されます。ローカル起動はCloudflareログイン不要で、AI bindingも既定ではありません。`.dev.vars.example` を `.dev.vars` にコピーして設定を上書きできます。秘密値はgitに入れないでください。

## 構成と互換性

TanStack Start + React + Tailwind CSS / Cloudflare Workers / D1 / Drizzle / Workers AI。確認時のStart **1.168.61**、Cloudflare Vite plugin **1.63.1**、Vite **8.3.4**、Wrangler **4.149.0** を正確なバージョンとlockfileで固定しています。Wranglerに同梱されるMiniflare **5.20261006.1-alpha** の設定形式を使ってテストしています。更新時は同じ検証一式を実行してください。

[Cloudflare公式TanStack Startガイド](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)（2026-10-11確認）に従い、Cloudflare plugin → Start → Reactの順番、SSR environment `ssr`、`nodejs_compat`、カスタムWorker entry `src/server.ts` を使用します。Nitroは不要です。TanStack Startが画面のSSR・hydration・routingを担当し、同じWorkerの `/api/*` が所有権・CSRF・D1・AIを処理します。

## 保存と匿名セッション

- Cookieには暗号学的な乱数32バイト（256bit）。サーバーはSHA-256のハッシュだけをD1の所有者として保存します。所有者をリクエスト本文やURLから受け取りません。
- HTTPSでは `__Host-kiroku`、`Secure; HttpOnly; SameSite=Strict; Path=/`。有効期間1年。HTTPはlocalhostに限り開発用Cookieを使用します。
- CRUD、検索、タグ絞り込み、要約の全処理に所有条件を付け、他セッションのIDは404。APIレスポンスにCookie値・所有者ハッシュを含めず、`no-store`。
- **Cookieの削除・紛失、ブラウザ変更後は復旧できません。** ログイン、端末間同期、回復鍵はありません。共有端末・同一ブラウザでは利用者間のプライバシーを保証できません。機密情報の保管用途には向きません。
- 保存はボタンで行います。未保存表示、離脱時の確認、保存失敗時の本文保持。ページを閉じた後の未保存入力は復元できません。
- タイトル120文字、本文8,000文字、タグ8個・各24文字、リクエスト40,000バイト。1セッション100メモ、サービス全体1,000メモ。DB triggerで同時作成でも容量制限を適用します。
- メモ数の上限が100件なので一覧・検索は最大100件を返します。所有者＋更新日時indexにより他セッションの本文を検索しません。検索は300ms debounce。更新・削除・要約保存はversionによる競合検出を行います。

書込はOrigin完全一致・カスタムヘッダー・JSON形式が必要です。クロスサイト要求を拒否し、CORSは開放していません。Reactの文字列描画で本文・タグ・AI出力をエスケープします。CSP、frame拒否、nosniff、HTTPS HSTSを付けています。Startのhydration用inline scriptのためCSP `script-src`には `unsafe-inline` が必要な構成です。HTML本文の挿入、外部スクリプト、Markdown HTMLの実行はありません。

## AIの安全な初期設定と予算

**AIは既定で無効です。** 以下の全条件が揃った場合だけ呼び出します。設定不足や不正な数値では503となり、偽の要約は返しません。

| 設定                     | 初期値  | 条件                                                   |
| ------------------------ | ------- | ------------------------------------------------------ |
| `AI_ENABLED`             | `false` | `true`で利用を許可                                     |
| `FREE_PLAN_CONFIRMED`    | `false` | 管理者が対象アカウントのWorkers Freeを確認後だけ`true` |
| `AI_DAILY_BUDGET`        | `5000`  | 1000〜5000予約単位/UTC日                               |
| `AI_SESSION_DAILY_LIMIT` | `3`     | 1〜10回/UTC日                                          |
| `AI` binding             | なし    | Cloudflare Workers AI binding                          |

モデルはFree対応モデル一覧と[公式モデルページ](https://developers.cloudflare.com/workers-ai/models/llama-3.2-3b-instruct/)を確認した `@cf/meta/llama-3.2-3b-instruct` に固定。本文のみ送信、3,000文字かつ12,000バイト以内、出力最大256tokens、temperature 0.2。要約精度、特に日本語の実モデル出力は本番接続後に確認が必要です。

AIを実行する**前**に、D1へ予約を1件INSERTします。SQLiteのtriggerが原子的に以下を検査します。アプリのメモリや地域単位レート制限には依存しません。

- 全体の同時実行は **1件**（UTC日をまたいでもactive予約を確認）。
- 1回 **1000単位** を予約し、日次全体予算を超える予約は拒否。初期値なら全体で最大5回/日。失敗・古い本文との競合でも返金・自動再試行しません。
- セッションの日次回数と、日付＋Cloudflareの接続元IPをSHA-256でハッシュした日次IP上限 **3回** を確認。IP不明時は全員が共通の保守的な枠になります。Cookieを変えても全体上限は回避できません。
- AI枠不足は429。binding・設定・D1不足は503。モデルエラー、Cloudflare側quota、空/不正出力で永続的なglobal停止フラグを立て、以後fail closed。
- ブラウザは45秒で待機を終了。サーバー側推論の終了は保証できないため、ブラウザの中断やWorkerの異常終了では予約は返金しません。active lockも勝手に期限切れにせず、進行中か不明なら追加推論を停止します。

1000単位は、小さな入力・出力上限と公開単価に対して余裕を持たせた**アプリ側の保守的な予約値**です。Cloudflareの実測neuronsを厳密に計算するものではなく、課金上限APIでもありません。別Worker/アプリのAI使用量は合算できません。無料運用の最終境界は対象アカウントが**Workers Free**であることです。

## 月額0円の前提

[Workers AI公式料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)ではFreeは10,000 neurons/日までで、超過後はエラー。Paidでは超過課金されます。**Paidを無料とみなしてAIを有効化しないでください。** 新しい課金必須モデル、AI Gateway credit、Paidへのupgradeは使用しません。

[Workers Free](https://developers.cloudflare.com/workers/platform/limits/)は100,000 requests/日・CPU 10ms/request等、[D1 Free](https://developers.cloudflare.com/d1/platform/pricing/)は5M rows read/日、100k rows written/日、[D1容量制約](https://developers.cloudflare.com/d1/platform/limits/)は1DB500MB・アカウント計5GB。2026-10-11確認。大量の検索・index write・悪意あるアクセス・他アプリの共通枠消費でも停止する可能性があります。これらの枠を超える負荷でも可用性を保証する設計ではありません。無料枠のCPUが本番のSSRで足りるかは公開後に計測してください。自動upgradeや有料サービスは設定しません。ローカルテストでは料金・本番CPUを保証できません。

## Cloudflareの最小セットアップ

未認証環境ではデプロイを保留します。ここまでの準備に課金・OAuth・規約同意は必要ありません。以下の認証、アカウント選択、Free確認、必要なモデル規約の確認は所有者が行ってください。

1. Cloudflareアカウントで **Workers Free** を確認。Paidしかない場合はAIを無効のままにし、この0円条件のデプロイ対象として扱わないでください。
2. 所有者がCLIを認証（例 `npx wrangler login`）。必要なOAuth権限や規約は所有者が確認します。既存トークンを使用する場合は環境へ安全に設定し、リポジトリやPRに貼らないでください。
3. `npx wrangler whoami` で対象アカウントを確認。複数アカウントなら `wrangler.jsonc` に対象 `account_id` を設定。
4. `npx wrangler d1 create kiroku` を実行し、返された `database_id` を `wrangler.jsonc` のゼロUUIDから置換。対象アカウントのWorkers Freeを確認済みなら `FREE_PLAN_CONFIRMED` を `"true"` に設定。`AI_ENABLED` は `"false"` のままです。`npm run deploy` はこの確認と実DB IDの設定がない場合、build・アップロード前に停止します。このフラグは所有者の確認を記録するもので、自動的にプランを検出するものではありません。
5. `npm run db:remote` → `npm run deploy`。`kiroku.<your-subdomain>.workers.dev` が表示されます。初回は**AI無効のまま**CRUD・HTTPS Cookie・別ブラウザ隔離を確認。
6. AIが必要ならFreeとモデル利用条件を所有者が確認後、`wrangler.jsonc` に `"ai": { "binding": "AI" }` を追加し、`AI_ENABLED` と `FREE_PLAN_CONFIRMED` を `"true"` にして再デプロイ。本番接続後に小さなメモ1件だけ要約を試し、Cloudflare dashboardの実使用量を確認。

`AI_ENABLED=false`で緊急停止できます。エラーによるglobal停止フラグの解除は、対象アカウントFree、quota、エラー原因と全予約の完了を確認後に、所有者が次を実行してください。未完了推論が疑われる場合は解除しません。

```sh
# まず確認（Cookie値やメモ本文は表示しない）
npx wrangler d1 execute kiroku --remote --command="SELECT id, day, active, created_at FROM ai_requests WHERE active = 1"
# 実際の推論終了を確認済みの予約のみ、idを指定して解除
npx wrangler d1 execute kiroku --remote --command="UPDATE ai_requests SET active = 0 WHERE id = 'CONFIRMED_FINISHED_RESERVATION_ID'"
# 原因解消と推論終了確認後だけglobal停止を解除
npx wrangler d1 execute kiroku --remote --command="UPDATE ai_control SET blocked = 0 WHERE id = 1"
```

予約履歴はD1へ保持します。不要な過去日の履歴を削除する場合もactive=0の終了確認済み記録のみ対象にし、当日の記録は残してください。Cookieを失ったメモは管理者からも個人を識別できず、回復機能はありません。

## 検証

```sh
npm run build               # routeTreeの生成・client/Worker build
npm run typecheck
npm run lint
npm test                    # 単体＋Miniflare実SQLite/D1統合、AIだけテスト用stub
npx playwright install chromium
npm run db:local
npm run test:e2e             # 実Worker、Chromium PC/スマホの操作
TEST_PREVIEW=1 npm run test:e2e  # 本番buildのworkerd previewでも同じ検証
npm run deploy:dry          # アップロードしない。認証不要
```

テストは別セッションのCRUD/検索/タグ/要約拒否、偽owner、CSRF、入力上限、楽観的競合、AI予約競合・日次枠・IP枠・quotaエラー・D1エラー・古い要約結果、保存失敗時の入力保持を確認します。AIのテストstubは自動テストだけに限定し、製品画面は未接続時に無効表示です。PC/スマホの実画面を `screenshots/` に保存します。screenshotsとtest-resultsはgit対象外。CIはNode24で同じ検証を実行し、deploy dry-runまで行います。自動本番デプロイや課金設定はありません。

## 未接続時に残る確認

本番Cloudflare認証・Freeプラン・D1 binding/マイグレーション・workers.dev公開URL、実AIの日本語品質とneurons使用量、実環境のCPU枠、Safari/Firefox実機はローカルのみでは検証できません。Chromiumのモバイルviewport検証は実iPhoneのSafari検証ではありません。
