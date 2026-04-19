import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDiscord } from "../src/discord.js";
import { fetchNotionPageSnapshot } from "../src/notion.js";
import { fetchPublicHtmlSnapshot } from "../src/public-html.js";
import { fetchRssSnapshot } from "../src/rss.js";
import { runSource } from "../src/source-runner.js";
import type { MonitorItem, MonitorState, NotionPageSource, RssSource } from "../src/types.js";

vi.mock("../src/discord.js", () => ({
  notifyDiscord: vi.fn()
}));

vi.mock("../src/rss.js", () => ({
  fetchRssSnapshot: vi.fn()
}));

vi.mock("../src/notion.js", () => ({
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
});
