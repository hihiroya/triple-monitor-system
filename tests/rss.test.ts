import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRssSnapshot } from "../src/rss.js";
import type { RssSource } from "../src/types.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const rssSource: RssSource = {
  key: "rss-main",
  type: "rss",
  label: "RSS",
  rssUrl: "https://example.com/feed.xml",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true,
  maxItems: 2
};

function stubFetch(body: string, status = 200): void {
  const fetchMock: FetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(body, { status }))
  );
  vi.stubGlobal("fetch", fetchMock);
}

describe("fetchRssSnapshot", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("RSS 2.0 の item を link ID として抽出し、maxItems を適用する", async () => {
    stubFetch(`<?xml version="1.0"?>
      <rss>
        <channel>
          <item>
            <title> First   News </title>
            <link>https://example.com/news/1</link>
            <pubDate>Sun, 19 Apr 2026 00:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Second News</title>
            <link>https://example.com/news/2</link>
          </item>
          <item>
            <title>Third News</title>
            <link>https://example.com/news/3</link>
          </item>
        </channel>
      </rss>`);

    const snapshot = await fetchRssSnapshot(rssSource);

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]).toEqual({
      id: "https://example.com/news/1",
      title: "First News",
      url: "https://example.com/news/1",
      timestamp: "2026-04-19T00:00:00.000Z"
    });
    expect(snapshot.items[1]).toMatchObject({
      id: "https://example.com/news/2",
      title: "Second News",
      url: "https://example.com/news/2"
    });
  });

  it("Atom の link href 形式を抽出する", async () => {
    stubFetch(`<?xml version="1.0"?>
      <feed>
        <entry>
          <title>Atom News</title>
          <link rel="alternate" href="https://example.com/atom/1" />
          <updated>2026-04-19T01:00:00.000Z</updated>
        </entry>
      </feed>`);

    const snapshot = await fetchRssSnapshot({ ...rssSource, maxItems: 10 });

    expect(snapshot.items).toEqual([
      {
        id: "https://example.com/atom/1",
        title: "Atom News",
        url: "https://example.com/atom/1"
      }
    ]);
  });

  it("HTTP エラーを詳細つきで失敗にする", async () => {
    stubFetch("server error", 500);

    await expect(fetchRssSnapshot(rssSource)).rejects.toThrow("HTTPエラー: 500");
  });

  it("有効な item が抽出できない RSS を失敗にする", async () => {
    stubFetch(`<?xml version="1.0"?>
      <rss>
        <channel>
          <item>
            <title>No Link</title>
          </item>
        </channel>
      </rss>`);

    await expect(fetchRssSnapshot(rssSource)).rejects.toThrow(
      "RSSから有効な item/link を抽出できませんでした"
    );
  });
});
