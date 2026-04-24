import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDiscord } from "../src/discord.js";
import { fetchNotionDatabaseSnapshot, fetchNotionPageSnapshot } from "../src/notion.js";
import { fetchPublicHtmlSnapshot } from "../src/public-html.js";
import { fetchRssSnapshot } from "../src/rss.js";
import { runSource } from "../src/source-runner.js";
import type {
  MonitorItem,
  MonitorState,
  NotionDatabaseSource,
  NotionPageSource,
  RssSource
} from "../src/types.js";

vi.mock("../src/discord.js", () => ({
  notifyDiscord: vi.fn()
}));

vi.mock("../src/rss.js", () => ({
  fetchRssSnapshot: vi.fn()
}));

vi.mock("../src/notion.js", () => ({
  fetchNotionDatabaseSnapshot: vi.fn(),
  fetchNotionPageSnapshot: vi.fn()
}));

vi.mock("../src/public-html.js", () => ({
  fetchPublicHtmlSnapshot: vi.fn()
}));

const rssSource: RssSource = {
  key: "rss-main",
  type: "rss",
  label: "RSS",
  rssUrl: "https://example.com/feed.xml",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true
};

const notionSource: NotionPageSource = {
  key: "notion-main",
  type: "notion_api_page_poll",
  label: "Notion",
  pageId: "00000000000000000000000000000000",
  notionTokenEnvName: "NOTION_TOKEN_MAIN",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true
};

const notionDatabaseSource: NotionDatabaseSource = {
  key: "notion-database-main",
  type: "notion_api_database_poll",
  label: "Notion Database",
  databaseId: "11111111111111111111111111111111",
  notionTokenEnvName: "NOTION_TOKEN_MAIN",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true
};

function item(id: string): MonitorItem {
  return {
    id,
    title: `item ${id}`,
    url: `https://example.com/${id}`
  };
}

describe("runSource", () => {
  beforeEach(() => {
    vi.mocked(notifyDiscord).mockReset();
    vi.mocked(fetchRssSnapshot).mockReset();
    vi.mocked(fetchNotionDatabaseSnapshot).mockReset();
    vi.mocked(fetchNotionPageSnapshot).mockReset();
    vi.mocked(fetchPublicHtmlSnapshot).mockReset();
  });

  it("list source の初回実行では通知せず baseline と seenItemIds を保存する", async () => {
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: [item("new"), item("old")]
    });
    const state: MonitorState = { sources: {} };

    const result = await runSource(rssSource, state);

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(notifyDiscord).not.toHaveBeenCalled();
    expect(state.sources["rss-main"]).toEqual({
      lastSeenItemId: "new",
      seenItemIds: ["new", "old"]
    });
  });

  it("list source の複数新着を古い順に通知し、成功後だけ state を進める", async () => {
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: [item("newest"), item("newer"), item("old")]
    });
    vi.mocked(notifyDiscord).mockResolvedValue(undefined);
    const state: MonitorState = {
      sources: {
        "rss-main": {
          lastSeenItemId: "old",
          seenItemIds: ["old"]
        }
      }
    };

    const result = await runSource(rssSource, state);

    expect(result).toMatchObject({ ok: true, changed: true, message: "2 件通知しました" });
    expect(notifyDiscord).toHaveBeenCalledTimes(2);
    expect(vi.mocked(notifyDiscord).mock.calls[0]?.[1]).toMatchObject({ id: "newer" });
    expect(vi.mocked(notifyDiscord).mock.calls[1]?.[1]).toMatchObject({ id: "newest" });
    expect(state.sources["rss-main"]?.lastSeenItemId).toBe("newest");
    expect(state.sources["rss-main"]?.seenItemIds).toEqual(["newest", "newer", "old"]);
  });

  it("list source の通知途中失敗では成功済み item までの state を保全する", async () => {
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: [item("newest"), item("newer"), item("old")]
    });
    vi.mocked(notifyDiscord)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("webhook failed"));
    const state: MonitorState = {
      sources: {
        "rss-main": {
          lastSeenItemId: "old",
          seenItemIds: ["old"]
        }
      }
    };

    const result = await runSource(rssSource, state);

    expect(result).toMatchObject({ ok: false, changed: false, message: "webhook failed" });
    expect(notifyDiscord).toHaveBeenCalledTimes(2);
    expect(state.sources["rss-main"]).toEqual({
      lastSeenItemId: "newer",
      seenItemIds: ["newer", "old"]
    });
  });

  it("list source は既読 item の間に挟まった未読 item も通知する", async () => {
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: [item("a"), item("n"), item("b"), item("c")]
    });
    vi.mocked(notifyDiscord).mockResolvedValue(undefined);
    const state: MonitorState = {
      sources: {
        "rss-main": {
          lastSeenItemId: "a",
          seenItemIds: ["a", "b", "c"]
        }
      }
    };

    const result = await runSource(rssSource, state);

    expect(result).toMatchObject({ ok: true, changed: true, message: "1 件通知しました" });
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyDiscord).mock.calls[0]?.[1]).toMatchObject({ id: "n" });
    expect(state.sources["rss-main"]).toEqual({
      lastSeenItemId: "a",
      seenItemIds: ["a", "n", "b", "c"]
    });
  });

  it("list source は既読範囲より古い未記録 item を新着扱いしない", async () => {
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: [item("known-newest"), item("known-middle"), item("known-oldest"), item("older")]
    });
    const state: MonitorState = {
      sources: {
        "rss-main": {
          lastSeenItemId: "known-newest",
          seenItemIds: ["known-newest", "known-middle", "known-oldest"]
        }
      }
    };

    const result = await runSource(rssSource, state);

    expect(result).toMatchObject({ ok: true, changed: false, message: "新着はありません" });
    expect(notifyDiscord).not.toHaveBeenCalled();
    expect(state.sources["rss-main"]).toEqual({
      lastSeenItemId: "known-newest",
      seenItemIds: ["known-newest", "known-middle", "known-oldest", "older"]
    });
  });

  it("list source は既読 item の間に挟まった未読 item の通知失敗時に既読化しない", async () => {
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: [item("a"), item("n"), item("b"), item("c")]
    });
    vi.mocked(notifyDiscord).mockRejectedValue(new Error("webhook failed"));
    const state: MonitorState = {
      sources: {
        "rss-main": {
          lastSeenItemId: "a",
          seenItemIds: ["a", "b", "c"]
        }
      }
    };

    const result = await runSource(rssSource, state);

    expect(result).toMatchObject({ ok: false, changed: false, message: "webhook failed" });
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(state.sources["rss-main"]).toEqual({
      lastSeenItemId: "a",
      seenItemIds: ["a", "b", "c"]
    });
  });

  it("list source で既読履歴が取得結果にない場合は大量通知せず失敗にする", async () => {
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: [item("newest"), item("newer")]
    });
    const state: MonitorState = {
      sources: {
        "rss-main": {
          lastSeenItemId: "missing",
          seenItemIds: ["missing"]
        }
      }
    };

    const result = await runSource(rssSource, state);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("既読 item が取得結果に見つかりません");
    expect(notifyDiscord).not.toHaveBeenCalled();
    expect(state.sources["rss-main"]).toEqual({
      lastSeenItemId: "missing",
      seenItemIds: ["missing"]
    });
  });

  it("YouTube RSS の 5xx は一時的な取得失敗としてスキップする", async () => {
    vi.mocked(fetchRssSnapshot).mockRejectedValue(
      new Error(
        "HTTPエラー: 500 Internal Server Error url=https://www.youtube.com/feeds/videos.xml?channel_id=channel"
      )
    );
    const state: MonitorState = {
      sources: {
        "youtube-rss": {
          lastSeenItemId: "old",
          seenItemIds: ["old"]
        }
      }
    };
    const youtubeSource: RssSource = {
      ...rssSource,
      key: "youtube-rss",
      rssUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=channel"
    };

    const result = await runSource(youtubeSource, state);

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(result.message).toContain("YouTube RSS の一時的な取得失敗");
    expect(state.sources["youtube-rss"]).toEqual({
      lastSeenItemId: "old",
      seenItemIds: ["old"]
    });
    expect(notifyDiscord).not.toHaveBeenCalled();
  });

  it("YouTube RSS でも XML 解析失敗はスキップしない", async () => {
    vi.mocked(fetchRssSnapshot).mockRejectedValue(new Error("RSS XMLの解析に失敗しました"));
    const state: MonitorState = { sources: {} };
    const youtubeSource: RssSource = {
      ...rssSource,
      key: "youtube-rss",
      rssUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=channel"
    };

    const result = await runSource(youtubeSource, state);

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      message: "RSS XMLの解析に失敗しました"
    });
  });

  it("YouTube 以外の RSS の 5xx は失敗として扱う", async () => {
    vi.mocked(fetchRssSnapshot).mockRejectedValue(
      new Error("HTTPエラー: 500 Internal Server Error url=https://example.com/feed.xml")
    );
    const state: MonitorState = { sources: {} };

    const result = await runSource(rssSource, state);

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      message: "HTTPエラー: 500 Internal Server Error url=https://example.com/feed.xml"
    });
  });

  it("version source の初回実行では通知せず version baseline を保存する", async () => {
    vi.mocked(fetchNotionPageSnapshot).mockResolvedValue({
      kind: "version",
      version: "2026-04-19T00:00:00.000Z",
      title: "Notion updated"
    });
    const state: MonitorState = { sources: {} };

    const result = await runSource(notionSource, state);

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(notifyDiscord).not.toHaveBeenCalled();
    expect(state.sources["notion-main"]).toEqual({
      lastSeenVersion: "2026-04-19T00:00:00.000Z"
    });
  });

  it("version source の更新時は通知成功後に version state を更新する", async () => {
    vi.mocked(fetchNotionPageSnapshot).mockResolvedValue({
      kind: "version",
      version: "2026-04-19T01:00:00.000Z",
      title: "Notion updated",
      url: "https://notion.so/page"
    });
    vi.mocked(notifyDiscord).mockResolvedValue(undefined);
    const state: MonitorState = {
      sources: {
        "notion-main": {
          lastSeenVersion: "2026-04-19T00:00:00.000Z"
        }
      }
    };

    const result = await runSource(notionSource, state);

    expect(result).toMatchObject({ ok: true, changed: true, message: "更新を通知しました" });
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyDiscord).mock.calls[0]?.[1]).toMatchObject({
      id: "2026-04-19T01:00:00.000Z",
      title: "Notion updated",
      url: "https://notion.so/page"
    });
    expect(state.sources["notion-main"]).toEqual({
      lastSeenVersion: "2026-04-19T01:00:00.000Z"
    });
  });

  it("database version source では Notion database snapshot を取得する", async () => {
    vi.mocked(fetchNotionDatabaseSnapshot).mockResolvedValue({
      kind: "version",
      version: "2026-04-19T02:00:00.000Z",
      title: "Database updated"
    });
    const state: MonitorState = { sources: {} };

    const result = await runSource(notionDatabaseSource, state);

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(fetchNotionDatabaseSnapshot).toHaveBeenCalledWith(notionDatabaseSource);
    expect(fetchNotionPageSnapshot).not.toHaveBeenCalled();
    expect(state.sources["notion-database-main"]).toEqual({
      lastSeenVersion: "2026-04-19T02:00:00.000Z"
    });
  });
});
