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

function tweetEntry(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    entryId: `tweet-${id}`,
    content: {
      itemContent: {
        tweet_results: {
          result: {
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
          }
        }
      }
    }
  };
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
    .mockResolvedValueOnce(
      Response.json({
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
      })
    )
    .mockResolvedValueOnce(
      Response.json({
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
      })
    );

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchXProfileSnapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("UserTweetsAndReplies から本人の親ポストだけを抽出する", async () => {
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.useFakeTimers();
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth-token");
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
    expect(timelineUrl).toContain("UserTweetsAndReplies");
  });
});
