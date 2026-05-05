# 設定変更

監視対象は `config/*.json` の source で管理します。secret の値は書かず、環境変数名だけを書きます。

## 共通フィールド

| key              | 説明                                   |
| ---------------- | -------------------------------------- |
| `key`            | state の識別子。重複不可               |
| `type`           | 監視タイプ                             |
| `label`          | Discord 通知のタイトル                 |
| `webhookEnvName` | Discord webhook URL を入れた環境変数名 |
| `enabled`        | `true` の source だけ実行              |
| `group`          | workflow の絞り込みに使う任意グループ  |

## RSS を追加する

```json
{
  "key": "example-rss",
  "type": "rss",
  "label": "Example RSS",
  "webhookEnvName": "DISCORD_WEBHOOK_URL_MAIN",
  "enabled": true,
  "group": "standard-rss",
  "rssUrl": "https://example.com/feed.xml",
  "maxItems": 20
}
```

通常 RSS は `group: "standard-rss"` にします。X/Twitter RSSHub route 用 source は `group: "x-twitter"` に分けます。

## X profile を追加する

```json
{
  "key": "example-x-profile",
  "type": "x_profile_poll",
  "label": "Example X",
  "webhookEnvName": "DISCORD_WEBHOOK_URL_MAIN",
  "enabled": true,
  "group": "x-profile",
  "screenName": "example",
  "xAuthTokenEnvName": "TWITTER_AUTH_TOKEN",
  "maxItems": 20,
  "maxAgeHours": 48,
  "includeRetweets": true
}
```

RSSHub 側にも同じアカウントの source がある場合は、重複通知を避けるためどちらか一方を無効化してください。

## Notion page を追加する

```json
{
  "key": "example-notion-page",
  "type": "notion_api_page_poll",
  "label": "Example Notion Page",
  "webhookEnvName": "DISCORD_WEBHOOK_URL_MAIN",
  "enabled": true,
  "group": "notion",
  "pageId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "notionTokenEnvName": "NOTION_TOKEN_MAIN"
}
```

## Notion database を追加する

```json
{
  "key": "example-notion-database",
  "type": "notion_api_database_poll",
  "label": "Example Notion Database",
  "webhookEnvName": "DISCORD_WEBHOOK_URL_MAIN",
  "enabled": true,
  "group": "notion",
  "databaseId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "notionTokenEnvName": "NOTION_TOKEN_MAIN"
}
```

database ID を page 監視へ指定すると Notion API が失敗します。database は必ず `notion_api_database_poll` と `databaseId` を使います。

## 公開 HTML 一覧を追加する

```json
{
  "key": "example-public-html",
  "type": "public_html_list_poll",
  "label": "Example HTML",
  "webhookEnvName": "DISCORD_WEBHOOK_URL_MAIN",
  "enabled": true,
  "group": "public-html",
  "url": "https://example.com/news/",
  "selectorStrategy": "example_news_list",
  "maxItems": 20
}
```

HTML はサイト改修で壊れやすいため、抽出は許可済み strategy に限定します。外部入力の selector 文字列をそのまま実行しない方針です。

追加手順:

1. `src/selector-strategies.ts` に strategy を追加します。
2. `src/types.ts` の `SelectorStrategyName` に strategy 名を追加します。
3. `tests/fixtures/` に対象 HTML の fixture を追加します。
4. `tests/selector-strategies.test.ts` に抽出テストを追加します。
5. `config/*.json` に source を追加します。
6. `npm run check` を実行します。

## Pagination

複数ページを巡回する場合は、抽出 strategy と URL 生成 strategy を分けます。

```json
{
  "pagination": {
    "strategy": "walkerplus_event_list_pages",
    "maxPages": 3
  }
}
```

対応済み pagination strategy:

| strategy                         | 用途                     |
| -------------------------------- | ------------------------ |
| `walkerplus_event_list_pages`    | Walkerplus event list    |
| `enjoytokyo_event_list_pages`    | Enjoy Tokyo event list   |
| `artscape_exhibition_list_pages` | Artscape exhibition list |

## 環境変数

| 環境変数                      | 説明                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `MONITOR_SOURCES_PATH`        | 読み込む sources。未指定時は `config/default-sources.json` |
| `MONITOR_STATE_PATH`          | 読み書きする state。未指定時は `state/default-state.json`  |
| `DISCORD_WEBHOOK_URL_MAIN`    | 既定通知先                                                 |
| `DISCORD_WEBHOOK_URL_TOURISM` | Tourism 通知先                                             |
| `NOTION_TOKEN_MAIN`           | Notion integration token                                   |
| `TWITTER_AUTH_TOKEN`          | X/Twitter 認証情報                                         |

`MONITOR_SOURCES_PATH` はカンマ区切りで複数指定できます。同じ `key` がある場合は後続ファイルの定義を採用します。

```bash
MONITOR_SOURCES_PATH=config/default-sources.json,config/tourism-sources.json
```

`MONITOR_STATE_PATH` もカンマ区切りを受け付けますが、更新する state は先頭ファイルだけです。

```bash
MONITOR_STATE_PATH=state/tourism-state.json
```
