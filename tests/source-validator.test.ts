import { describe, expect, it } from "vitest";
import { validateSources } from "../src/source-validator.js";

describe("validateSources", () => {
  it("RSS、Notion、公開HTMLの有効な設定を検証して正規化する", () => {
    const sources = validateSources([
      {
        key: "rss-main",
        type: "rss",
        label: "RSS",
        rssUrl: "https://example.com/feed.xml",
        webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
        enabled: true,
        group: "standard-rss",
        maxItems: 10
      },
      {
        key: "notion-main",
        type: "notion_api_page_poll",
        label: "Notion",
        pageId: "00000000-0000-0000-0000-000000000000",
        notionTokenEnvName: "NOTION_TOKEN_MAIN",
        webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
        enabled: false
      },
      {
        key: "notion-database-main",
        type: "notion_api_database_poll",
        label: "Notion Database",
        databaseId: "11111111-1111-1111-1111-111111111111",
        notionTokenEnvName: "NOTION_TOKEN_MAIN",
        webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
        enabled: true
      },
      {
        key: "html-main",
        type: "public_html_list_poll",
        label: "HTML",
        url: "https://example.com/news/",
        webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
        enabled: true,
        selectorStrategy: "revuestarlight_news_list",
        maxItems: 20
      }
    ]);

    expect(sources).toHaveLength(4);
    expect(sources[0]).toMatchObject({
      key: "rss-main",
      type: "rss",
      rssUrl: "https://example.com/feed.xml",
      group: "standard-rss"
    });
    expect(sources[1]).toMatchObject({
      key: "notion-main",
      type: "notion_api_page_poll",
      pageId: "00000000000000000000000000000000"
    });
    expect(sources[2]).toMatchObject({
      key: "notion-database-main",
      type: "notion_api_database_poll",
      databaseId: "11111111111111111111111111111111"
    });
    expect(sources[3]).toMatchObject({
      key: "html-main",
      type: "public_html_list_poll",
      url: "https://example.com/news/",
      selectorStrategy: "revuestarlight_news_list"
    });
  });

  it("walkerplus 用 selectorStrategy も受け付ける", () => {
    const [source] = validateSources([
      {
        key: "walkerplus-art-events",
        type: "public_html_list_poll",
        label: "Walkerplus",
        url: "https://www.walkerplus.com/event_list/ar0300/eg0107/",
        webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
        enabled: true,
        selectorStrategy: "walkerplus_event_list",
        maxItems: 10,
        pagination: {
          strategy: "walkerplus_event_list_pages",
          maxPages: 5
        }
      }
    ]);

    expect(source).toMatchObject({
      key: "walkerplus-art-events",
      type: "public_html_list_poll",
      selectorStrategy: "walkerplus_event_list",
      pagination: {
        strategy: "walkerplus_event_list_pages",
        maxPages: 5
      }
    });
  });

  it("EnjoyTokyo 用 selectorStrategy と pagination strategy も受け付ける", () => {
    const [source] = validateSources([
      {
        key: "enjoytokyo-tokyo-art-events",
        type: "public_html_list_poll",
        label: "レッツエンジョイ東京",
        url: "https://www.enjoytokyo.jp/event/list/cat04/",
        webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
        enabled: true,
        selectorStrategy: "enjoytokyo_event_list",
        maxItems: 75,
        pagination: {
          strategy: "enjoytokyo_event_list_pages",
          maxPages: 5
        }
      }
    ]);

    expect(source).toMatchObject({
      key: "enjoytokyo-tokyo-art-events",
      type: "public_html_list_poll",
      selectorStrategy: "enjoytokyo_event_list",
      pagination: {
        strategy: "enjoytokyo_event_list_pages",
        maxPages: 5
      }
    });
  });

  it("artscape 用 selectorStrategy と pagination strategy も受け付ける", () => {
    const [source] = validateSources([
      {
        key: "artscape-kantou-exhibitions",
        type: "public_html_list_poll",
        label: "artscape",
        url: "https://artscape.jp/exhibitions/?area=kantou",
        webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
        enabled: true,
        selectorStrategy: "artscape_exhibition_list",
        maxItems: 75,
        pagination: {
          strategy: "artscape_exhibition_list_pages",
          maxPages: 5
        }
      }
    ]);

    expect(source).toMatchObject({
      key: "artscape-kantou-exhibitions",
      type: "public_html_list_poll",
      selectorStrategy: "artscape_exhibition_list",
      pagination: {
        strategy: "artscape_exhibition_list_pages",
        maxPages: 5
      }
    });
  });

  it("未許可の pagination strategy を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "walkerplus-art-events",
          type: "public_html_list_poll",
          label: "Walkerplus",
          url: "https://www.walkerplus.com/event_list/ar0300/eg0107/",
          webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
          enabled: true,
          selectorStrategy: "walkerplus_event_list",
          pagination: {
            strategy: "unknown"
          }
        }
      ])
    ).toThrow("未許可の pagination strategy です");
  });

  it("トップレベルが配列でない設定を拒否する", () => {
    expect(() => validateSources({ key: "rss-main" })).toThrow(
      "sources.json のトップレベルは配列である必要があります"
    );
  });

  it("source key の重複を拒否する", () => {
    const source = {
      key: "duplicated",
      type: "rss",
      label: "RSS",
      rssUrl: "https://example.com/feed.xml",
      webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
      enabled: true
    };

    expect(() => validateSources([source, source])).toThrow("source key が重複しています");
  });

  it("未対応の source type を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "unknown",
          type: "unknown",
          label: "Unknown",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true
        }
      ])
    ).toThrow("未対応の source type です");
  });

  it("HTTP(S) 以外の URL を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "rss-main",
          type: "rss",
          label: "RSS",
          rssUrl: "file:///etc/passwd",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true
        }
      ])
    ).toThrow("rssUrl は http または https URL である必要があります");
  });

  it("GitHub Secrets に不向きな環境変数名を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "rss-main",
          type: "rss",
          label: "RSS",
          rssUrl: "https://example.com/feed.xml",
          webhookEnvName: "discordWebhook",
          enabled: true
        }
      ])
    ).toThrow("webhookEnvName は GitHub Secrets に使いやすい");
  });

  it("不正な group 名を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "rss-main",
          type: "rss",
          label: "RSS",
          rssUrl: "https://example.com/feed.xml",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true,
          group: "Invalid Group"
        }
      ])
    ).toThrow("group は小文字英数字");
  });

  it("許可されていない selectorStrategy を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "html-main",
          type: "public_html_list_poll",
          label: "HTML",
          url: "https://example.com/news/",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true,
          selectorStrategy: "free_form_selector"
        }
      ])
    ).toThrow("未許可の selectorStrategy です");
  });

  it("不正な Notion pageId を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "notion-main",
          type: "notion_api_page_poll",
          label: "Notion",
          pageId: "invalid",
          notionTokenEnvName: "NOTION_TOKEN_MAIN",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true
        }
      ])
    ).toThrow("pageId は 32 桁の Notion ID である必要があります");
  });

  it("不正な Notion databaseId を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "notion-database-main",
          type: "notion_api_database_poll",
          label: "Notion Database",
          databaseId: "invalid",
          notionTokenEnvName: "NOTION_TOKEN_MAIN",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true
        }
      ])
    ).toThrow("databaseId は 32 桁の Notion ID である必要があります");
  });

  it("範囲外の maxItems を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "rss-main",
          type: "rss",
          label: "RSS",
          rssUrl: "https://example.com/feed.xml",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true,
          maxItems: 101
        }
      ])
    ).toThrow("maxItems は 1 以上 100 以下の整数である必要があります");
  });

  it("x_profile_poll の includeRetweets を検証して正規化する", () => {
    const [source] = validateSources([
      {
        key: "x-profile",
        type: "x_profile_poll",
        label: "X Profile",
        screenName: "revuestarlight",
        xAuthTokenEnvName: "TWITTER_AUTH_TOKEN",
        webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
        enabled: true,
        maxItems: 20,
        maxAgeHours: 72,
        includeRetweets: true
      }
    ]);

    expect(source).toMatchObject({
      key: "x-profile",
      type: "x_profile_poll",
      screenName: "revuestarlight",
      includeRetweets: true
    });
  });

  it("不正な includeRetweets を拒否する", () => {
    expect(() =>
      validateSources([
        {
          key: "x-profile",
          type: "x_profile_poll",
          label: "X Profile",
          screenName: "revuestarlight",
          xAuthTokenEnvName: "TWITTER_AUTH_TOKEN",
          webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
          enabled: true,
          includeRetweets: "yes"
        }
      ])
    ).toThrow("includeRetweets は boolean である必要があります");
  });
});
