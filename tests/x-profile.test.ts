import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchXProfileSnapshot } from "../src/x-profile.js";
import type { XProfileSource } from "../src/types.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const source: XProfileSource = {
  key: "revuestarlight-x-profile",
  type: "x_profile_poll",
  label: "X Profile",
  screenName: "revuestarlight",
  xAuthTokenEnvName: "TWITTER_AUTH_TOKEN",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true,
  maxItems: 10,
  maxAgeHours: 72
};

function tweetResult(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rest_id: id,
    core: {
      user_results: {
        result: {
          legacy: {
            name: "少女☆歌劇 レヴュースタァライト",
            screen_name: "revuestarlight"
          }
        }
      }
    },
    legacy: {
      id_str: id,
      user_id_str: "12345",
      full_text: `post ${id}`,
      created_at: "Tue Apr 21 10:00:00 +0000 2026",
      ...overrides
    }
  };
}

function tweetEntry(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        tweet_results: {
          result: tweetResult(id, overrides)
        }
      }
    }
  };
}

function timelineResponse(entries: unknown[]): Response {
  return Response.json({
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries
                }
              ]
            }
          }
        }
      }
    }
  });
}

function userResponse(): Response {
  return Response.json({
    data: {
      user: {
        result: {
          rest_id: "12345",
          legacy: {
            name: "少女☆歌劇 レヴュースタァライト",
            screen_name: "revuestarlight"
          }
        }
      }
    }
  });
}

function stubFetchTimeline(entries: unknown[]): FetchMock {
  const fetchMock: FetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response("", {
        status: 200,
        headers: {
          "set-cookie": "ct0=csrf-token; Path=/; Secure"
        }
      })
    )
    .mockResolvedValueOnce(userResponse())
    .mockResolvedValueOnce(timelineResponse(entries));

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchXProfileSnapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("UserTweets から本人の親ポストだけを抽出する", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.useFakeTimers();
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth-token");
    vi.stubEnv("X_GQL_USER_TWEETS", "test-query/UserTweets");
    const fetchMock = stubFetchTimeline([
      tweetEntry("parent"),
      tweetEntry("reply", { in_reply_to_status_id_str: "parent" }),
      tweetEntry("retweet", { retweeted_status: {} }),
      tweetEntry("other-user", { user_id_str: "67890" }),
      tweetEntry("old", { created_at: "Fri Apr 17 10:00:00 +0000 2026" })
    ]);

    const snapshot = await fetchXProfileSnapshot(source);

    expect(snapshot.items).toEqual([
      {
        id: "https://x.com/revuestarlight/status/parent",
        title: "少女☆歌劇 レヴュースタァライト: post parent",
        url: "https://x.com/revuestarlight/status/parent",
        timestamp: "2026-04-21T10:00:00.000Z"
      }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const timelineInput = fetchMock.mock.calls[2]?.[0];
    if (typeof timelineInput !== "string") {
      throw new Error("timeline fetch URL is not a string");
    }
    const timelineUrl = timelineInput;
    expect(timelineUrl).toContain("UserTweets");
  });

  it("ct0 を含む cookie secret では cookie 初期化リクエストを省く", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.useFakeTimers();
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth_token=auth-token; ct0=csrf-token");
    vi.stubEnv("X_GQL_USER_TWEETS", "test-query/UserTweets");
    const fetchMock: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(userResponse())
      .mockResolvedValueOnce(timelineResponse([tweetEntry("parent")]));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchXProfileSnapshot(source);

    expect(snapshot.items[0]?.id).toBe("https://x.com/revuestarlight/status/parent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("404 時に X の script から GraphQL endpoint を解決して再試行する", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.useFakeTimers();
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth-token");
    const html = `<script src="/responsive-web/client.js"></script>`;
    const script = `"new-user-query/UserByScreenName";"new-timeline-query/UserTweets";`;
    const fetchMock: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(html, {
          status: 200,
          headers: {
            "set-cookie": "ct0=csrf-token; Path=/; Secure"
          }
        })
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(script, { status: 200 }))
      .mockResolvedValueOnce(userResponse())
      .mockResolvedValueOnce(new Response(script, { status: 200 }))
      .mockResolvedValueOnce(timelineResponse([tweetEntry("parent")]));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchXProfileSnapshot(source);

    expect(snapshot.items[0]?.id).toBe("https://x.com/revuestarlight/status/parent");
    expect(fetchMock.mock.calls[3]?.[0]).toEqual(
      expect.stringContaining("new-user-query/UserByScreenName")
    );
    expect(fetchMock.mock.calls[5]?.[0]).toEqual(
      expect.stringContaining("new-timeline-query/UserTweets")
    );
  });

  it("UserTweets が 404 の場合は UserTweetsAndReplies にフォールバックする", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.useFakeTimers();
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth-token");
    vi.stubEnv("X_GQL_USER_TWEETS", "old-query/UserTweets");
    vi.stubEnv("X_GQL_USER_TWEETS_AND_REPLIES", "fallback-query/UserTweetsAndReplies");
    const fetchMock: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", {
          status: 200,
          headers: {
            "set-cookie": "ct0=csrf-token; Path=/; Secure"
          }
        })
      )
      .mockResolvedValueOnce(userResponse())
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(timelineResponse([tweetEntry("parent")]));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchXProfileSnapshot(source);

    expect(snapshot.items[0]?.id).toBe("https://x.com/revuestarlight/status/parent");
    expect(fetchMock.mock.calls[2]?.[0]).toEqual(expect.stringContaining("old-query/UserTweets"));
    expect(fetchMock.mock.calls[4]?.[0]).toEqual(
      expect.stringContaining("fallback-query/UserTweetsAndReplies")
    );
  });

  it("note_tweet の本文と maxItems を反映する", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.useFakeTimers();
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth-token");
    vi.stubEnv("X_GQL_USER_TWEETS", "test-query/UserTweets");
    stubFetchTimeline([
      {
        entryId: "tweet-note",
        content: {
          itemContent: {
            tweet_results: {
              result: {
                tweet: {
                  ...tweetResult("note", { full_text: "legacy text" }),
                  note_tweet: {
                    note_tweet_results: {
                      result: {
                        text: "note tweet text"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      tweetEntry("second")
    ]);

    const snapshot = await fetchXProfileSnapshot({ ...source, maxItems: 1 });

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.title).toContain("note tweet text");
  });

  it("親ポストが見つからない場合は失敗する", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.useFakeTimers();
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth-token");
    vi.stubEnv("X_GQL_USER_TWEETS", "test-query/UserTweets");
    stubFetchTimeline([tweetEntry("reply", { in_reply_to_status_id_str: "parent" })]);

    await expect(fetchXProfileSnapshot(source)).rejects.toThrow(
      "X profile monitor found no parent posts"
    );
  });
});
