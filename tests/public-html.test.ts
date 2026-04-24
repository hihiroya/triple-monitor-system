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
});
