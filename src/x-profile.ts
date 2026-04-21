import type { ListSnapshot, MonitorItem, XProfileSource } from "./types.js";
import { clampMaxItems, fetchWithTimeout, getRequiredEnv, normalizeWhitespace } from "./utils.js";

const X_API_BASE_URL = "https://x.com/i/api/graphql";
const X_HOME_URL = "https://x.com";
const X_BEARER_TOKEN =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const DEFAULT_MAX_AGE_HOURS = 72;
const MIN_TIMELINE_FETCH_COUNT = 50;
const MAX_DYNAMIC_ENDPOINT_CANDIDATES = 5;

const GQL_OPERATION_NAMES = {
  userByScreenName: "UserByScreenName",
  userTweets: "UserTweets",
  userTweetsAndReplies: "UserTweetsAndReplies"
} as const;
type GqlOperationKey = keyof typeof GQL_OPERATION_NAMES;

function getConfiguredEndpoint(operationName: GqlOperationKey): string | undefined {
  switch (operationName) {
    case "userByScreenName":
      return process.env.X_GQL_USER_BY_SCREEN_NAME ?? "IGgvgiOx4QZndDHuD3x9TQ/UserByScreenName";
    case "userTweets":
      return process.env.X_GQL_USER_TWEETS;
    case "userTweetsAndReplies":
      return (
        process.env.X_GQL_USER_TWEETS_AND_REPLIES ?? "Yt1JzwcBsBWYEEi3jMTe2Q/UserTweetsAndReplies"
      );
  }
}

const USER_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true
};

const TIMELINE_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false
};

interface XAuth {
  cookie: string;
  csrfToken: string;
  html: string;
}

interface XUser {
  id: string;
  screenName: string;
  name: string;
}

interface XLegacyTweet {
  id_str?: string;
  user_id_str?: string;
  full_text?: string;
  created_at?: string;
  in_reply_to_status_id_str?: string | null;
  retweeted_status_result?: unknown;
  retweeted_status?: unknown;
  user?: {
    name?: string;
    screen_name?: string;
  };
}

function parseCookieHeader(cookie: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey && rawValue.length > 0) {
      result.set(rawKey, rawValue.join("="));
    }
  }
  return result;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = withGetSetCookie.getSetCookie?.();
  if (setCookies && setCookies.length > 0) {
    return setCookies;
  }
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function mergeSetCookies(cookie: string, setCookieHeaders: string[]): string {
  const cookies = parseCookieHeader(cookie);
  for (const setCookie of setCookieHeaders) {
    const firstPart = setCookie.split(";")[0];
    if (!firstPart) {
      continue;
    }
    const [key, ...value] = firstPart.trim().split("=");
    if (key && value.length > 0) {
      cookies.set(key, value.join("="));
    }
  }
  return Array.from(cookies.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function buildXAuth(source: XProfileSource): Promise<XAuth> {
  const tokenOrCookie = getRequiredEnv(source.xAuthTokenEnvName);
  const initialCookie = tokenOrCookie.includes("auth_token=")
    ? tokenOrCookie
    : `auth_token=${tokenOrCookie}`;
  const initialCookies = parseCookieHeader(initialCookie);
  if (initialCookies.has("ct0")) {
    return {
      cookie: initialCookie,
      csrfToken: initialCookies.get("ct0") ?? "",
      html: ""
    };
  }

  const response = await fetchWithTimeout(`${X_HOME_URL}/${source.screenName}?mx=2`, {
    headers: {
      Cookie: initialCookie,
      "User-Agent": "triple-monitor-system/1.0 X profile monitor"
    }
  });
  const html = await response.text();
  const cookie = mergeSetCookies(initialCookie, getSetCookieHeaders(response.headers));
  const csrfToken = parseCookieHeader(cookie).get("ct0");
  if (!csrfToken) {
    throw new Error("X profile monitor could not obtain ct0 cookie from auth_token");
  }
  return { cookie, csrfToken, html };
}

async function fetchXJson(
  operationName: string,
  endpoint: string,
  params: Record<string, unknown>,
  auth: XAuth
): Promise<unknown> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  const response = await fetchWithTimeout(`${X_API_BASE_URL}/${endpoint}?${query.toString()}`, {
    headers: {
      Accept: "*/*",
      Authorization: X_BEARER_TOKEN,
      "Cache-Control": "no-cache",
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      Pragma: "no-cache",
      Referer: "https://x.com/",
      "User-Agent": "triple-monitor-system/1.0 X profile monitor",
      "x-csrf-token": auth.csrfToken,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "ja"
    }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `X Web API error: operation=${operationName} endpoint=${endpoint} status=${
        response.status
      } body=${normalizeWhitespace(body).slice(0, 500)}`
    );
  }
  return JSON.parse(body) as unknown;
}

function extractScriptUrls(html: string): string[] {
  const urls = new Set<string>();
  const pattern = /<script[^>]+src=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const src = match[1];
    if (!src || !src.includes("/responsive-web/")) {
      continue;
    }
    try {
      urls.add(new URL(src, X_HOME_URL).toString());
    } catch {
      // Ignore malformed script URLs from X markup.
    }
  }
  return Array.from(urls);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function findEndpointsInScript(script: string, operationName: string): string[] {
  const escapedName = operationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const endpoints: string[] = [];
  const patterns = [
    new RegExp(`["']([A-Za-z0-9_-]{10,})/${escapedName}["']`, "g"),
    new RegExp(
      `queryId["']?\\s*[:=]\\s*["']([A-Za-z0-9_-]{10,})["'][\\s\\S]{0,500}${escapedName}`,
      "g"
    ),
    new RegExp(
      `${escapedName}[\\s\\S]{0,500}queryId["']?\\s*[:=]\\s*["']([A-Za-z0-9_-]{10,})["']`,
      "g"
    )
  ];
  for (const pattern of patterns) {
    for (const match of script.matchAll(pattern)) {
      if (match[1]) {
        endpoints.push(`${match[1]}/${operationName}`);
      }
    }
  }
  return uniqueStrings(endpoints);
}

async function resolveEndpointsFromScripts(
  operationName: string,
  auth: XAuth,
  screenName: string
): Promise<string[]> {
  const html =
    auth.html ||
    (await fetchTextWithAuth(`${X_HOME_URL}/${screenName}?mx=2`, auth).catch(() => ""));
  const scriptUrls = extractScriptUrls(html).slice(0, 25);
  const endpoints: string[] = [];
  for (const scriptUrl of scriptUrls) {
    const response = await fetchWithTimeout(scriptUrl, {
      headers: {
        Cookie: auth.cookie,
        "User-Agent": "triple-monitor-system/1.0 X profile monitor"
      }
    }).catch(() => undefined);
    if (!response?.ok) {
      continue;
    }
    endpoints.push(...findEndpointsInScript(await response.text(), operationName));
    if (endpoints.length >= MAX_DYNAMIC_ENDPOINT_CANDIDATES) {
      break;
    }
  }
  return uniqueStrings(endpoints).slice(0, MAX_DYNAMIC_ENDPOINT_CANDIDATES);
}

async function fetchTextWithAuth(url: string, auth: XAuth): Promise<string> {
  const response = await fetchWithTimeout(url, {
    headers: {
      Cookie: auth.cookie,
      "User-Agent": "triple-monitor-system/1.0 X profile monitor"
    }
  });
  return response.ok ? response.text() : "";
}

async function fetchXJsonWithEndpointFallback(
  operationName: GqlOperationKey,
  params: Record<string, unknown>,
  auth: XAuth,
  screenName: string
): Promise<unknown> {
  const gqlOperationName = GQL_OPERATION_NAMES[operationName];
  const candidates: string[] = [];
  const configuredEndpoint = getConfiguredEndpoint(operationName);
  if (configuredEndpoint) {
    candidates.push(configuredEndpoint);
  }

  const attempted = new Set<string>();
  let lastNotFoundError: unknown;
  let dynamicResolved = false;
  for (;;) {
    for (const endpoint of uniqueStrings(candidates)) {
      if (attempted.has(endpoint)) {
        continue;
      }
      attempted.add(endpoint);
      try {
        return await fetchXJson(gqlOperationName, endpoint, params, auth);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("status=404")) {
          throw error;
        }
        lastNotFoundError = error;
      }
    }

    if (dynamicResolved) {
      break;
    }
    dynamicResolved = true;
    for (const endpoint of await resolveEndpointsFromScripts(gqlOperationName, auth, screenName)) {
      if (!candidates.includes(endpoint)) {
        candidates.push(endpoint);
      }
    }
    if (candidates.length === 0) {
      break;
    }
  }

  if (lastNotFoundError instanceof Error) {
    throw lastNotFoundError;
  }
  throw new Error(`X Web API endpoint not found: operation=${gqlOperationName}`);
}

function isXWebApiNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("status=404") || message.includes("endpoint not found");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return current;
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function extractUser(response: unknown, screenName: string): XUser {
  const user =
    getPath(response, ["data", "user", "result"]) ??
    getPath(response, ["data", "user_result", "result"]);
  const record = asRecord(user);
  const legacy = asRecord(record?.legacy);
  const id = record?.rest_id;
  if (typeof id !== "string") {
    throw new Error(`X user not found: screenName=${screenName}`);
  }
  return {
    id,
    screenName: typeof legacy?.screen_name === "string" ? legacy.screen_name : screenName,
    name: typeof legacy?.name === "string" ? legacy.name : screenName
  };
}

function extractInstructions(response: unknown): unknown[] {
  const instructions =
    getPath(response, ["data", "user", "result", "timeline", "timeline", "instructions"]) ??
    getPath(response, ["data", "user", "result", "timeline", "timeline_v2", "instructions"]) ??
    getPath(response, ["data", "user", "result", "timeline_v2", "timeline", "instructions"]);
  return Array.isArray(instructions) ? instructions : [];
}

function extractTimelineEntries(response: unknown): unknown[] {
  const instructions = extractInstructions(response);
  const entries: unknown[] = [];
  for (const instruction of instructions) {
    const record = asRecord(instruction);
    const moduleItems = asUnknownArray(record?.moduleItems);
    entries.push(...moduleItems);

    const rawEntries = asUnknownArray(record?.entries);
    if (rawEntries.length > 0) {
      entries.push(...rawEntries);
      for (const entry of rawEntries) {
        entries.push(...asUnknownArray(getPath(entry, ["content", "items"])));
      }
    }
  }
  return entries;
}

function extractTweetResult(entry: unknown): Record<string, unknown> | undefined {
  const tweet =
    getPath(entry, ["content", "itemContent", "tweet_results", "result"]) ??
    getPath(entry, ["content", "content", "tweetResult", "result"]) ??
    getPath(entry, ["item", "itemContent", "tweet_results", "result"]);
  const record = asRecord(tweet);
  const nestedTweet = asRecord(record?.tweet);
  return nestedTweet ?? record;
}

function legacyFromTweet(tweet: Record<string, unknown>): XLegacyTweet | undefined {
  const legacy = asRecord(tweet.legacy) as XLegacyTweet | undefined;
  if (!legacy) {
    return undefined;
  }
  if (typeof legacy.id_str !== "string" && typeof tweet.rest_id === "string") {
    legacy.id_str = tweet.rest_id;
  }
  const user =
    getPath(tweet, ["core", "user_result", "result", "legacy"]) ??
    getPath(tweet, ["core", "user_results", "result", "legacy"]);
  const userRecord = asRecord(user);
  if (userRecord) {
    const legacyUser: NonNullable<XLegacyTweet["user"]> = {};
    if (typeof userRecord.name === "string") {
      legacyUser.name = userRecord.name;
    }
    if (typeof userRecord.screen_name === "string") {
      legacyUser.screen_name = userRecord.screen_name;
    }
    legacy.user = legacyUser;
  }
  const noteText = getPath(tweet, ["note_tweet", "note_tweet_results", "result", "text"]);
  if (typeof noteText === "string" && noteText.trim() !== "") {
    legacy.full_text = noteText;
  }
  return legacy;
}

function isTargetTimelinePost(
  tweet: XLegacyTweet,
  user: XUser,
  cutoffTime: number,
  includeRetweets: boolean
): boolean {
  if (!tweet.id_str || tweet.user_id_str !== user.id) {
    return false;
  }
  if (tweet.in_reply_to_status_id_str) {
    return false;
  }
  if (!includeRetweets && (tweet.retweeted_status_result || tweet.retweeted_status)) {
    return false;
  }
  const timestamp = tweet.created_at ? new Date(tweet.created_at).getTime() : Number.NaN;
  return Number.isFinite(timestamp) && timestamp >= cutoffTime;
}

function tweetToMonitorItem(tweet: XLegacyTweet, user: XUser): MonitorItem {
  const url = `https://x.com/${user.screenName}/status/${tweet.id_str}`;
  const text = normalizeWhitespace(tweet.full_text ?? "");
  const title = text ? `${user.name}: ${text}` : `${user.name} posted on X`;
  const item: MonitorItem = {
    id: url,
    title,
    url
  };
  if (tweet.created_at) {
    item.timestamp = new Date(tweet.created_at).toISOString();
  }
  return item;
}

function sortByTimestampDesc(items: MonitorItem[]): MonitorItem[] {
  return [...items].sort((a, b) => {
    const timestampA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const timestampB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return timestampB - timestampA;
  });
}

/**
 * X profile の Web API から本人の親ポストと、設定に応じて RT を抽出する。
 *
 * RSSHub の Web API 実装と同じく UserByScreenName と profile timeline を使うが、
 * ページングや検索は行わず、返信を除外して API 呼び出し数と誤通知を抑える。
 */
export async function fetchXProfileSnapshot(source: XProfileSource): Promise<ListSnapshot> {
  const maxItems = clampMaxItems(source.maxItems);
  const maxAgeHours = source.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const includeRetweets = source.includeRetweets ?? false;
  const cutoffTime = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const auth = await buildXAuth(source);

  const userResponse = await fetchXJsonWithEndpointFallback(
    "userByScreenName",
    {
      variables: {
        screen_name: source.screenName,
        withSafetyModeUserFields: true
      },
      features: USER_FEATURES,
      fieldToggles: {
        withAuxiliaryUserLabels: false
      }
    },
    auth,
    source.screenName
  );
  const user = extractUser(userResponse, source.screenName);

  const timelineParams = {
    variables: {
      userId: user.id,
      count: Math.max(maxItems, MIN_TIMELINE_FETCH_COUNT),
      includePromotedContent: false,
      withCommunity: true,
      withVoice: true,
      withV2Timeline: true
    },
    features: TIMELINE_FEATURES,
    fieldToggles: {
      withArticlePlainText: false
    }
  };
  let timelineResponse: unknown;
  try {
    timelineResponse = await fetchXJsonWithEndpointFallback(
      "userTweets",
      timelineParams,
      auth,
      source.screenName
    );
  } catch (error) {
    if (!isXWebApiNotFound(error)) {
      throw error;
    }
    timelineResponse = await fetchXJsonWithEndpointFallback(
      "userTweetsAndReplies",
      timelineParams,
      auth,
      source.screenName
    );
  }

  const seen = new Set<string>();
  const items: MonitorItem[] = [];
  for (const entry of extractTimelineEntries(timelineResponse)) {
    const tweet = extractTweetResult(entry);
    const legacy = tweet ? legacyFromTweet(tweet) : undefined;
    if (!legacy || !isTargetTimelinePost(legacy, user, cutoffTime, includeRetweets)) {
      continue;
    }
    const item = tweetToMonitorItem(legacy, user);
    if (!seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
    if (items.length >= maxItems) {
      break;
    }
  }

  const sortedItems = sortByTimestampDesc(items).slice(0, maxItems);
  if (sortedItems.length === 0) {
    throw new Error(
      `X profile monitor found no parent posts: screenName=${source.screenName} maxAgeHours=${maxAgeHours}`
    );
  }

  return { kind: "list", items: sortedItems };
}
