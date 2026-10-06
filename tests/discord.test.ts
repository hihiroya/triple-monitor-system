import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";
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
    vi.useRealTimers();
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

  it("Discord HTTP エラーは本文を含めず失敗する", async () => {
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    stubFetch(new Response("bad webhook", { status: 400 }));

    await expect(notifyDiscord(source, item)).rejects.toThrow("status=400");
  });

  it("429 rate limit は retry-after を尊重して再試行する", async () => {
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    vi.useFakeTimers();
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

    const pending = notifyDiscord(source, item);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 が続く場合は最大試行後に失敗する", async () => {
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    vi.useFakeTimers();
    const fetchMock: FetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response("still limited", {
          status: 429,
          headers: {
            "retry-after": "1"
          }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const assertion = expect(notifyDiscord(source, item)).rejects.toThrow("reason=attempt-limit");
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails a stalled response body within 20s without leaking payloads or credentials", async () => {
    vi.useFakeTimers();
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/secret-token";
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const response = new Response("private notification content", { status: 400 });
    vi.spyOn(response, "arrayBuffer").mockImplementation(() => new Promise(() => {}));
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>((_, init) => {
      signal = init?.signal;
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(notifyDiscord(source, item)).rejects.toThrow(
      "stage=body reason=timeout"
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logs = [...info.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(logs).toContain('source="rss-main"');
    expect(logs).toContain("item_sha256=");
    expect(logs).toContain("attempt=1 status=400");
    expect(logs).toContain("elapsed_ms=20000");
    expect(logs).not.toMatch(/secret-token|discord.com|private notification content|News Title/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["31", new Date(Date.now() + 60_000).toUTCString()])(
    "fails excessive Retry-After %s without resending earlier than requested",
    async (retryAfter) => {
      vi.useFakeTimers();
      process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
      const fetchMock = stubFetch(
        new Response("private", { status: 429, headers: { "retry-after": retryAfter } })
      );
      await expect(notifyDiscord(source, item)).rejects.toThrow(
        "stage=retry-wait reason=wait-budget"
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("limits cumulative waits, not just each individual Retry-After", async () => {
    vi.useFakeTimers();
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("private", { status: 429, headers: { "retry-after": "20" } }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(notifyDiscord(source, item)).rejects.toThrow("reason=wait-budget");
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("permits the full 30s cumulative wait budget and at most three attempts", async () => {
    vi.useFakeTimers();
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "15" } }))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "15" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = notifyDiscord(source, item);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a wait longer than the remaining total budget without a resend", async () => {
    vi.useFakeTimers();
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    const clock = vi.spyOn(performance, "now");
    const fetchMock = vi.fn<typeof fetch>(() => {
      clock.mockReturnValue(85_000);
      return Promise.resolve(new Response(null, { status: 429, headers: { "retry-after": "10" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(notifyDiscord(source, item)).rejects.toThrow("reason=total-timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts in-flight retry communication within the remaining 90s budget", async () => {
    vi.useFakeTimers();
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    const clock = vi.spyOn(performance, "now");
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }))
      .mockImplementationOnce((_, init) => {
        signal = init?.signal;
        return new Promise(() => {});
      });
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(notifyDiscord(source, item)).rejects.toThrow("reason=total-timeout");
    await vi.advanceTimersByTimeAsync(0);
    // Simulate scheduler delay consuming the budget before the retry starts.
    clock.mockReturnValue(89_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(90_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the total deadline interrupts a delayed retry wait and clears all timers", async () => {
    vi.useFakeTimers();
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://discord.com/api/webhooks/test/token";
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay) =>
      schedule(callback, delay === 1_000 ? 100_000 : delay)
    );
    const fetchMock = stubFetch(
      new Response(null, { status: 429, headers: { "retry-after": "1" } })
    );
    const assertion = expect(notifyDiscord(source, item)).rejects.toThrow(
      "stage=retry-wait reason=total-timeout"
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not propagate a network exception containing the webhook or authorization", async () => {
    vi.useFakeTimers();
    process.env.DISCORD_WEBHOOK_URL_MAIN = "https://example.invalid/secret-webhook";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new Error(
            "https://example.invalid/secret-webhook Authorization: private-token notification-body"
          )
        )
    );
    await expect(notifyDiscord(source, item)).rejects.toThrow("stage=headers reason=network");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(
      /secret-webhook|private-token|notification-body/
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
