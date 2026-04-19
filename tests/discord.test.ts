import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyDiscord } from "../src/discord.js";
import type { MonitorItem, RssSource } from "../src/types.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const source: RssSource = {
  key: "rss-main",
  type: "rss",
  label: "RSS Label",
  rssUrl: "https://example.com/feed.xml",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true
};

const item: MonitorItem = {
  id: "https://example.com/news/1",
  title: "News Title",
  url: "https://example.com/news/1",
  timestamp: "2026-04-19T00:00:00.000Z"
};

function stubFetch(response: Response): FetchMock {
  const fetchMock: FetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("notifyDiscord", () => {
  afterEach(() => {
    delete process.env.DISCORD_WEBHOOK_URL_MAIN;
    delete process.env.DISCORD_RETRY_DELAY_OVERRIDE_MS;
    vi.unstubAllGlobals();
  });

  it("Discord webhook に embed payload を POST する", async () => {
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await notifyDiscord(source, item);

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("fetch が呼び出されていません");
    }

    const [url, init] = firstCall;
    expect(url).toBe("https://discord.com/api/webhooks/test/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json"
    });
    if (typeof init?.body !== "string") {
      throw new Error("Discord payload body が string ではありません");
    }
    expect(JSON.parse(init.body)).toEqual({
      embeds: [
        {
          title: "RSS Label",
          description: "News Title\nhttps://example.com/news/1",
          url: "https://example.com/news/1",
          timestamp: "2026-04-19T00:00:00.000Z"
        }
      ]
    });
  });

  it("webhook env が未設定なら fetch せず失敗する", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyDiscord(source, item)).rejects.toThrow(
      "必要な環境変数 DISCORD_WEBHOOK_URL_MAIN が設定されていません"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Discord HTTP エラーは本文つきで失敗する", async () => {
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    stubFetch(new Response("bad webhook", { status: 400 }));

    await expect(notifyDiscord(source, item)).rejects.toThrow(
      "Discord通知に失敗しました: status=400 body=bad webhook"
    );
  });

  it("429 rate limit は retry-after を尊重して再試行する", async () => {
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    process.env.DISCORD_RETRY_DELAY_OVERRIDE_MS = "0";
    const fetchMock: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: {
            "retry-after": "1"
          }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await notifyDiscord(source, item);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 が続く場合は最大試行後に失敗する", async () => {
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    process.env.DISCORD_RETRY_DELAY_OVERRIDE_MS = "0";
    const fetchMock: FetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("still limited", {
        status: 429,
        headers: {
          "retry-after": "1"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyDiscord(source, item)).rejects.toThrow(
      "Discord通知に失敗しました: status=429 body=still limited"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
