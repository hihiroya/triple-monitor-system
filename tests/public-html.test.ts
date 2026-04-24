import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHtmlSnapshot } from "../src/public-html.js";
import type { PublicHtmlListSource } from "../src/types.js";

describe("fetchPublicHtmlSnapshot", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pagination 設定がある場合は複数ページを集約する", async () => {
    const page1 = await readFile("tests/fixtures/walkerplus-event-list.html", "utf8");
    const page2 = await readFile("tests/fixtures/walkerplus-event-list-page-2.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/event_list/ar0300/eg0107/")) {
          return Promise.resolve(new Response(page1, { status: 200 }));
        }
        if (url.endsWith("/event_list/ar0300/eg0107/2.html")) {
          return Promise.resolve(new Response(page2, { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      })
    );

    const source: PublicHtmlListSource = {
      key: "walkerplus-art-events",
      type: "public_html_list_poll",
      label: "Walkerplus",
      url: "https://www.walkerplus.com/event_list/ar0300/eg0107/",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      selectorStrategy: "walkerplus_event_list",
      maxItems: 5,
      pagination: {
        strategy: "walkerplus_event_list_pages",
        maxPages: 2
      }
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.items.map((item) => item.id)).toEqual([
      "https://www.walkerplus.com/event/ar0313e583830/",
      "https://www.walkerplus.com/event/ar0313e558982/",
      "https://www.walkerplus.com/event/ar0313e583109/",
      "https://www.walkerplus.com/event/ar0313e564406/",
      "https://www.walkerplus.com/event/ar0313e577379/"
    ]);
  });

  it("EnjoyTokyo のページ送り設定で複数ページを集約する", async () => {
    const page1 = await readFile("tests/fixtures/enjoytokyo-event-list.html", "utf8");
    const page2 = await readFile("tests/fixtures/enjoytokyo-event-list-page-2.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/event/list/cat04/")) {
          return Promise.resolve(new Response(page1, { status: 200 }));
        }
        if (url.endsWith("/event/list/cat04/2/")) {
          return Promise.resolve(new Response(page2, { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      })
    );

    const source: PublicHtmlListSource = {
      key: "enjoytokyo-tokyo-art-events",
      type: "public_html_list_poll",
      label: "レッツエンジョイ東京 展示・展覧会",
      url: "https://www.enjoytokyo.jp/event/list/cat04/",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      selectorStrategy: "enjoytokyo_event_list",
      maxItems: 5,
      pagination: {
        strategy: "enjoytokyo_event_list_pages",
        maxPages: 2
      }
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.items.map((item) => item.id)).toEqual([
      "https://www.enjoytokyo.jp/event/2060940/",
      "https://www.enjoytokyo.jp/event/1500577/",
      "https://www.enjoytokyo.jp/event/2056459/",
      "https://www.enjoytokyo.jp/event/2018932/",
      "https://www.enjoytokyo.jp/event/2050000/"
    ]);
  });

  it("artscape のページ送り設定で paged クエリを付けて複数ページを集約する", async () => {
    const page1 = await readFile("tests/fixtures/artscape-exhibition-list.html", "utf8");
    const page2 = await readFile("tests/fixtures/artscape-exhibition-list-page-2.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url === "https://artscape.jp/exhibitions/?area=kantou") {
          return Promise.resolve(new Response(page1, { status: 200 }));
        }
        if (url === "https://artscape.jp/exhibitions/?area=kantou&paged=2") {
          return Promise.resolve(new Response(page2, { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      })
    );

    const source: PublicHtmlListSource = {
      key: "artscape-kantou-exhibitions",
      type: "public_html_list_poll",
      label: "artscape 関東地方の展覧会・展示会",
      url: "https://artscape.jp/exhibitions/?area=kantou",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      selectorStrategy: "artscape_exhibition_list",
      maxItems: 3,
      pagination: {
        strategy: "artscape_exhibition_list_pages",
        maxPages: 2
      }
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.items.map((item) => item.id)).toEqual([
      "https://artscape.jp/exhibitions/67441/",
      "https://artscape.jp/exhibitions/66742/",
      "https://artscape.jp/exhibitions/65956/"
    ]);
  });

  it("Science Portal の埋め込みイベントデータから list snapshot を作る", async () => {
    const html = await readFile("tests/fixtures/scienceportal-event-list.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (
          url ===
          "https://scienceportal.jst.go.jp/events/?s_held_month=all&s_category=exhibition,event&exclude_finished"
        ) {
          return Promise.resolve(new Response(html, { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      })
    );

    const source: PublicHtmlListSource = {
      key: "scienceportal-exhibition-events",
      type: "public_html_list_poll",
      label: "Science Portal 展示・イベント",
      url: "https://scienceportal.jst.go.jp/events/?s_held_month=all&s_category=exhibition,event&exclude_finished",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      selectorStrategy: "scienceportal_event_list",
      maxItems: 2
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.items.map((item) => item.id)).toEqual([
      "https://scienceportal.jst.go.jp/events/19447/",
      "https://scienceportal.jst.go.jp/events/19446/"
    ]);
  });

  it("追加ページの取得失敗は既に取得済みの item があれば部分取得で続行する", async () => {
    const page1 = await readFile("tests/fixtures/walkerplus-event-list.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/event_list/ar0300/eg0107/")) {
          return Promise.resolve(new Response(page1, { status: 200 }));
        }
        if (url.endsWith("/event_list/ar0300/eg0107/2.html")) {
          return Promise.reject(new Error("network timeout"));
        }
        return Promise.reject(new Error(`unexpected url ${url}`));
      })
    );

    const source: PublicHtmlListSource = {
      key: "walkerplus-art-events",
      type: "public_html_list_poll",
      label: "Walkerplus",
      url: "https://www.walkerplus.com/event_list/ar0300/eg0107/",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      selectorStrategy: "walkerplus_event_list",
      maxItems: 50,
      pagination: {
        strategy: "walkerplus_event_list_pages",
        maxPages: 2
      }
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.items.map((item) => item.id)).toEqual([
      "https://www.walkerplus.com/event/ar0313e583830/",
      "https://www.walkerplus.com/event/ar0313e558982/",
      "https://www.walkerplus.com/event/ar0313e583109/"
    ]);
  });

  it("1ページ目の取得失敗は source 失敗として扱う", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network timeout")))
    );

    const source: PublicHtmlListSource = {
      key: "walkerplus-art-events",
      type: "public_html_list_poll",
      label: "Walkerplus",
      url: "https://www.walkerplus.com/event_list/ar0300/eg0107/",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      selectorStrategy: "walkerplus_event_list",
      maxItems: 50,
      pagination: {
        strategy: "walkerplus_event_list_pages",
        maxPages: 2
      }
    };

    await expect(fetchPublicHtmlSnapshot(source)).rejects.toThrow("network timeout");
  });
});
