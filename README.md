# Triple Monitor System

GitHub Actions 上で RSS、Notion API ページ、公開 HTML 一覧を定期監視し、新着や更新を Discord webhook に通知する汎用監視基盤です。

実行環境は Node.js 24 LTS 前提です。GitHub Actions でも `actions/setup-node@v6` で Node 24 を明示し、ローカル開発環境との差異を減らしています。

## 概要

このリポジトリは 3 種類の監視を同じ state 形式と通知処理で扱います。差分管理と通知の安全性を共通化すると、監視タイプが違っても「初回は通知しない」「通知成功後だけ既読にする」「1 source の失敗を他 source に波及させない」という運用ルールを揃えられます。

workflow は `rss-monitor.yml`、`x-twitter-monitor.yml`、`notion-monitor.yml`、`public-site-monitor.yml` に分けています。監視先の失敗原因、必要な Secrets、実行頻度を種類ごとに切り分けやすくするためです。state ファイルは共通なので、workflow の concurrency は同じ `monitor-state` にして直列実行します。

## ファイル構成

```text
.
├─ .github/workflows/
│  ├─ rss-monitor.yml
│  ├─ x-twitter-monitor.yml
│  ├─ notion-monitor.yml
│  ├─ public-site-monitor.yml
│  └─ quality-check.yml
├─ .github/actions/
│  └─ commit-monitor-state/
├─ .vscode/
│  ├─ extensions.json
│  └─ settings.json
├─ config/sources.json
├─ src/
│  ├─ config.ts
│  ├─ discord.ts
│  ├─ logger.ts
│  ├─ main.ts
│  ├─ notion.ts
│  ├─ public-html.ts
│  ├─ rss.ts
│  ├─ selector-strategies.ts
│  ├─ source-runner.ts
│  ├─ source-validator.ts
│  ├─ state.ts
│  ├─ types.ts
│  ├─ utils.ts
│  └─ validate-config.ts
├─ tests/
│  ├─ fixtures/
│  │  └─ revuestarlight-news-list.html
│  ├─ discord.test.ts
│  ├─ logger.test.ts
│  ├─ main.test.ts
│  ├─ notion.test.ts
│  ├─ quality-gates.test.ts
│  ├─ rss.test.ts
│  ├─ selector-strategies.test.ts
│  ├─ source-runner.test.ts
│  ├─ source-validator.test.ts
│  └─ state.test.ts
├─ state/monitor-state.json
├─ eslint.config.mjs
├─ knip.json
├─ package.json
├─ tsconfig.json
├─ tsconfig.typecheck.json
├─ vitest.config.ts
├─ .editorconfig
├─ .prettierignore
└─ .prettierrc.json
```

## セットアップ

1. 依存関係をインストールします。

```bash
node --version
npm ci
```

2. `config/sources.json` を編集し、使う source の `enabled` を `true` にします。

3. GitHub リポジトリの `Settings > Secrets and variables > Actions` に Secrets を登録します。

```text
DISCORD_WEBHOOK_URL_MAIN
NOTION_TOKEN_MAIN
TWITTER_AUTH_TOKEN
```

4. GitHub Actions の `workflow_dispatch` か schedule で実行します。

## sources.json

`sources.json` は配列です。全 source 共通で次のキーを持ちます。

| キー             | 説明                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `key`            | state の識別子です。重複不可です。                                                                  |
| `type`           | `rss`、`notion_api_page_poll`、`notion_api_database_poll`、`public_html_list_poll` のいずれかです。 |
| `label`          | Discord 通知のタイトルです。                                                                        |
| `webhookEnvName` | Discord webhook URL を入れた環境変数名です。                                                        |
| `enabled`        | `true` の source だけ監視します。                                                                   |
| `group`          | 任意の実行グループです。RSS workflow の分割実行に使います。                                         |

RSS では `rssUrl` と任意の `maxItems` を使います。Notion page では `pageId` と `notionTokenEnvName`、Notion database では `databaseId` と `notionTokenEnvName` を使います。公開 HTML では `url`、`selectorStrategy`、任意の `maxItems` を使います。

## 監視タイプ

### RSS

RSS/Atom XML を取得し、`link` を item ID として扱います。前回の `lastSeenItemId` より新しい item を古い順に Discord へ通知します。

通常 RSS は `rss-monitor.yml` が `group=standard-rss` だけを実行します。X/Twitter の RSS は `x-twitter-monitor.yml` が GitHub Actions runner 内で RSSHub service を起動し、`group=x-twitter` の source だけを `http://127.0.0.1:1200/twitter/user/...` から取得します。RSSHub の X/Twitter route は認証が必要なため、GitHub Secrets に `TWITTER_AUTH_TOKEN` を登録してください。これはログイン済み X/Twitter Web の Cookie `auth_token` の値です。

X/Twitter source は RSSHub の routeParams を使えます。スレッド付き投稿が通常 timeline に出ない場合は、まず対象 source の `rssUrl` に `/forceWebApi=1&count=50` のような routeParams を追加して、RSSHub 側の取得結果に対象ポストが含まれるか確認してください。返信ポストまで必要な場合は、RSSHub image を最新 digest に更新したうえで `/includeReplies=1&forceWebApi=1&count=50` を段階的に試してください。Actions ログの `list snapshot` には取得 item 数、既読交差数、先頭 10 件の item ID サンプルが出ます。

RSSHub は workflow 内の一時 container として起動するため、永続 cache は持ちません。既読管理はこのリポジトリの `state/monitor-state.json` が担当します。監視頻度を短くしすぎると X/Twitter 側の制限に触れやすいため、通常は現在の 30 分間隔を基準にしてください。

RSSHub の container image は `ghcr.io/diygod/rsshub@sha256:...` で digest 固定しています。これにより、workflow ファイルを変えない限り同じ image を使い続け、予期しない upstream 更新を避けます。X/Twitter の取得が壊れた場合や定期更新時は、GHCR の `latest` digest を確認し、`x-twitter-monitor.yml` の image digest を更新してから `X Twitter Monitor` を手動実行してください。

### Notion API

Notion の retrieve page API または retrieve database API を呼び出し、`last_edited_time` を `lastSeenVersion` と比較します。Notion integration を作成し、対象ページまたは対象データベースに integration を招待したうえで、internal integration token を GitHub Secrets に登録してください。database ID を `notion_api_page_poll` に指定すると Notion API は `Provided ID ... is a database, not a page` を返すため、database 監視には `notion_api_database_poll` と `databaseId` を使います。

### 公開 HTML 一覧

HTML はサイト改修で壊れやすいため、抽出処理は `selector-strategies.ts` のホワイトリストに分離しています。現在は `revuestarlight_news_list` を実装済みです。外部入力の selector 文字列をそのまま使わず、許可した strategy 関数だけを実行します。

## 初回挙動と state

初回実行時は既存記事や既存更新を大量通知しないため、通知せずに `state/monitor-state.json` へ現在位置だけを保存します。RSS と公開 HTML では `lastSeenItemId` に加えて短い `seenItemIds` 履歴を保存し、一覧順の軽い揺れに備えます。

2 回目以降は差分を検知し、通知が成功した item または version だけ state を進めます。通知に失敗した場合は未通知扱いのまま残るため、次回再試行できます。取得結果に既読履歴がまったく含まれない場合は、重複通知を避けるため source 失敗として扱います。`maxItems` が小さすぎる、対象サイトの並び順が変わった、HTML 構造が変わった、といった原因を確認してください。

## 動作確認

```bash
npm run typecheck
npm run build
npm run validate:config
npm run lint
npm run knip
npm run audit
npm test
npm run test:coverage
npm run format:check
npm run monitor:rss
npm run monitor:rss:standard
npm run monitor:x-twitter
npm run monitor:notion
npm run monitor:public-html
```

ローカルで実行する場合は、必要な環境変数を設定してください。

```bash
export DISCORD_WEBHOOK_URL_MAIN="https://discord.com/api/webhooks/..."
export NOTION_TOKEN_MAIN="secret_..."
export TWITTER_AUTH_TOKEN="..."
```

PowerShell の場合:

```powershell
$env:DISCORD_WEBHOOK_URL_MAIN="https://discord.com/api/webhooks/..."
$env:NOTION_TOKEN_MAIN="secret_..."
$env:TWITTER_AUTH_TOKEN="..."
```

## トラブルシュート

- `必要な環境変数 ... が設定されていません`: `webhookEnvName` または `notionTokenEnvName` と GitHub Secrets の名前を揃えてください。
- `TWITTER_AUTH_TOKEN secret is required for X/Twitter RSSHub routes.`: GitHub Secrets に `TWITTER_AUTH_TOKEN` を登録してください。
- `RSSHub did not become ready in time.`: RSSHub container の起動失敗、GHCR 側の一時障害、または runner のネットワーク制限を確認してください。
- X/Twitter だけ失敗する場合: `X Twitter Monitor`、`TWITTER_AUTH_TOKEN`、RSSHub digest を確認してください。通常 RSS は別 workflow の `RSS Monitor` で切り分けられます。
- `HTML一覧から記事リンクを抽出できませんでした`: 対象サイトの HTML 構造が変わった可能性があります。`selector-strategies.ts` の strategy を更新してください。
- `既読 item が取得結果に見つかりません`: `maxItems` を増やすか、RSS/HTML の取得順と selector strategy を確認してください。
- `Provided ID ... is a database, not a page`: `type` を `notion_api_database_poll` にし、`pageId` ではなく `databaseId` を使ってください。
- `Notion APIレスポンスに last_edited_time がありません`: `pageId`、`databaseId`、integration の権限を確認してください。
- Actions は 1 source でも失敗すると最後に失敗扱いになります。ただし source ごとに try/catch しているため、他 source の監視は継続されます。

## セキュリティ注意

Discord webhook URL、Notion token、X/Twitter の `auth_token` は GitHub Secrets に登録し、`sources.json` には環境変数名やローカル RSSHub URL だけを書いてください。ログには URL や token を出さない実装にしていますが、設定値そのものをコミットしない運用を守ってください。

RSSHub は `x-twitter-monitor.yml` の service container として runner 内だけで使います。`TWITTER_AUTH_TOKEN` は RSSHub と secret 事前チェックの step にだけ渡し、監視アプリ本体には渡しません。X/Twitter の `auth_token` はアカウントへのアクセス権に近い機密値なので、定期的に更新し、不要になったら GitHub Secrets から削除してください。

## 開発者向け品質チェック

監視処理は「通知する」「state を進める」という副作用を持つため、型チェック、lint、format を分けて確認します。破壊的な変更を早めに見つけるため、pull request では `quality-check.yml` が同じ確認を実行します。

```bash
npm run typecheck
npm run build
npm run validate:config
npm run lint
npm run knip
npm run test:coverage
npm run format:check
```

ローカルで pull request 前の品質ゲートをまとめて確認する場合:

```bash
npm run check
```

整形を適用する場合:

```bash
npm run format
```

ESLint の自動修正を試す場合:

```bash
npm run lint:fix
```

`typecheck` は TypeScript の型安全性を確認します。`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` を有効にしているのは、state の未定義アクセスや optional property の扱いを曖昧にしないためです。監視基盤では「通知済みかどうか」の境界が重要なので、型で表現できる不整合はコンパイル時に止めます。

`lint` は危険な書き方を検出します。特に `no-floating-promises` は、Discord 通知や state 保存の Promise を待ち忘れて処理が進む事故を防ぐために重要です。また、`src/logger.ts` 以外での `console` 直書きを禁止しています。ログは secret マスクを通す必要があるため、出力は `logger` 経由にしてください。

`knip` は未使用 export と未使用 dependencies を検出します。ESLint だけでは NodeNext の `.js` import specifier や CLI entrypoint 周りの判定が難しいため、`knip.json` で `src/main.ts` と `src/validate-config.ts` を entrypoint として明示しています。

`format:check` は Prettier による整形差分を検出します。lint は危険なコードや保守性の問題を見つける役割、format は見た目の揺れをなくす役割です。レビューではロジックの差分に集中できるよう、整形は Prettier に任せます。

`npm test` は Vitest でユニットテストを実行します。まずは `source-runner.ts` の通知順と state 保全、`source-validator.ts` の fail-fast を重点的に確認しています。

`test:coverage` は Vitest coverage を実行し、全体の statements、branches、functions、lines に下限を設けます。通知処理や state 更新の退行を早く検出するため、CI では通常の `npm test` ではなく coverage 付きのテストを使います。

`validate:config` は build 済みの `dist/validate-config.js` を実行し、実際の `config/sources.json` と `state/monitor-state.json` を検証します。設定ファイルの typo や壊れた state は監視実行時ではなく pull request 時点で検出します。

`quality-check.yml` は監視 workflow とは分けています。監視の失敗とコード品質の失敗を別々に追跡でき、開発中の pull request と default branch への push では secret scan、`npm ci`、`typecheck`、`build`、`validate:config`、`lint`、`knip`、`audit`、`test:coverage`、`format:check`、`actionlint` をまとめて確認します。`actionlint` は workflow の YAML 構文、`schedule`、`concurrency` などの記述ミスを早期に検出するために使います。`quality-gates.test.ts` では RSSHub image の digest 固定、`TWITTER_AUTH_TOKEN` の渡し先、通常 RSS と X/Twitter RSS の group 分割も検査します。

secret scan は Gitleaks を使い、Discord webhook URL、Notion token、その他 API token の誤コミットを検出します。検出時は CI を失敗させます。PR コメント権限を増やさないため `GITLEAKS_ENABLE_COMMENTS=false` にしています。Organization 配下のリポジトリで `gitleaks/gitleaks-action` を使う場合は、必要に応じて `GITLEAKS_LICENSE` を GitHub Secrets に登録してください。

`gitleaks/gitleaks-action` は Node.js 20 runtime の action なので、`quality-check.yml` では `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` を設定し、GitHub Actions runner の Node.js 24 強制切替を先取りしています。将来 Gitleaks action が Node.js 24 対応版を出した場合は、SHA を更新してこの互換設定が不要か確認してください。

`audit` は `npm audit` を実行し、dependencies と devDependencies の既知脆弱性を検出します。GitHub Actions 上では devDependencies も build、lint、test に使うため、CI では `--omit=dev` ではなく全体を確認します。一方でネットワーク依存のチェックなので、ローカルの `npm run check` には含めていません。

Dependabot は npm dependencies と GitHub Actions を週次で確認します。各 workflow には `timeout-minutes` を設定し、外部サイトや API の一時的な停止で Actions が長時間占有されることを防ぎます。

GitHub Actions の action pinning は、公式 action と third-party action で扱いを分けます。`actions/checkout` と `actions/setup-node` は公式 action のため major tag を維持し、Dependabot で更新を追います。一方で third-party action は supply-chain リスクを下げるため SHA 固定します。現在は `rhysd/actionlint` と `gitleaks/gitleaks-action` を SHA 固定しています。

監視 workflow の state commit 処理は `.github/actions/commit-monitor-state` の composite action に集約しています。RSS、Notion、公開 HTML の workflow は commit message だけを渡すため、retry や rebase 処理を修正するときの差分漏れを避けられます。

CLI smoke test は build 済みの `dist/main.js` を実際に起動します。外部通信を避けるため、`MONITOR_SOURCES_PATH` と `MONITOR_STATE_PATH` でテスト用ファイルへ差し替えられるようにしています。

新しいテストを追加する場合は、優先度の高い順に以下を対象にしてください。

1. `utils.ts` の timeout、HTTP error、JSON parse helper
2. `logger.ts` の secret mask
3. workflow の state commit retry を検証する仕組み
4. 実サイト HTML の構造変更に備えた selector fixture の継続追加

Windows や制限付き sandbox では、Vitest が内部で使う esbuild の process spawn が拒否される場合があります。通常の GitHub Actions Ubuntu runner では問題になりにくいですが、ローカルで `EPERM` が出る場合は、権限やセキュリティソフトの制限を確認してください。

開発時の推奨フロー:

1. 実装する
2. `npm run typecheck`
3. `npm run build`
4. `npm run validate:config`
5. `npm run lint`
6. `npm run knip`
7. `npm run test:coverage`
8. `npm run format:check`
9. 必要なら `npm run format` または `npm run lint:fix`
10. GitHub Actions の `Quality Check` を確認する
