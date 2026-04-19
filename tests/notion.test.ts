import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNotionPageSnapshot } from "../src/notion.js";
import type { NotionPageSource } from "../src/types.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const notionSource: NotionPageSource = {
  key: "notion-main",
  type: "notion_api_page_poll",
  label: "Notion Label",
  pageId: "00000000000000000000000000000000",
  notionTokenEnvName: "NOTION_TOKEN_MAIN",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true
};

function createResponseInit(status: number, headers?: HeadersInit): ResponseInit {
  const init: ResponseInit = { status };
  if (headers) {
    init.headers = headers;
  }
  return init;
}

function stubFetchJson(body: unknown, status = 200, headers?: HeadersInit): FetchMock {
  const fetchMock: FetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(body), createResponseInit(status, headers)))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFetchText(body: string, status: number, headers?: HeadersInit): FetchMock {
  const fetchMock: FetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(body, createResponseInit(status, headers)))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchNotionPageSnapshot", () => {
  beforeEach(() => {
    process.env.NOTION_TOKEN_MAIN = "secret_test_token";
  });

  afterEach(() => {
    delete process.env.NOTION_TOKEN_MAIN;
    vi.unstubAllGlobals();
  });

  it("retrieve page レスポンスから last_edited_time と title を抽出する", async () => {
    const fetchMock = stubFetchJson({
      id: "page-id",
      url: "https://notion.so/page-id",
      last_edited_time: "2026-04-19T02:00:00.000Z",
      properties: {
        Name: {
          type: "title",
          title: [
            {
              plain_text: "監視ページ"
            }
          ]
        }
      }
    });

    const snapshot = await fetchNotionPageSnapshot(notionSource);

    expect(snapshot).toEqual({
      kind: "version",
      version: "2026-04-19T02:00:00.000Z",
      title: "監視ページ が更新されました",
      url: "https://notion.so/page-id",
      timestamp: "2026-04-19T02:00:00.000Z"
    });
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("fetch が呼び出されていません");
    }

    const [url, init] = firstCall;
    expect(url).toBe("https://api.notion.com/v1/pages/00000000000000000000000000000000");
    if (!init || init.headers instanceof Headers || Array.isArray(init.headers)) {
      throw new Error("fetch headers を検証できません");
    }
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret_test_token",
      "Notion-Version": "2022-06-28"
    });
  });

  it("title property がない場合は source label を使う", async () => {
    stubFetchJson({
      last_edited_time: "2026-04-19T02:00:00.000Z"
    });

    const snapshot = await fetchNotionPageSnapshot(notionSource);

    expect(snapshot.title).toBe("Notion Label が更新されました");
  });

  it("NOTION token が未設定なら fetch せず失敗する", async () => {
    delete process.env.NOTION_TOKEN_MAIN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchNotionPageSnapshot(notionSource)).rejects.toThrow(
      "必要な環境変数 NOTION_TOKEN_MAIN が設定されていません"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 を権限エラーとして説明する", async () => {
    stubFetchText("forbidden", 403);

    await expect(fetchNotionPageSnapshot(notionSource)).rejects.toThrow(
      "Notion API 権限エラーです"
    );
  });

  it("404 を pageId 確認エラーとして説明する", async () => {
    stubFetchText("not found", 404);

    await expect(fetchNotionPageSnapshot(notionSource)).rejects.toThrow(
      "Notion API でページが見つかりません"
    );
  });

  it("429 では retry-after を含めて説明する", async () => {
    stubFetchText("rate limited", 429, {
      "retry-after": "30"
    });

    await expect(fetchNotionPageSnapshot(notionSource)).rejects.toThrow("retryAfter=30s");
  });

  it("JSON parse error を説明する", async () => {
    stubFetchText("{invalid json", 200);

    await expect(fetchNotionPageSnapshot(notionSource)).rejects.toThrow(
      "Notion API JSONの解析に失敗しました"
    );
  });

  it("last_edited_time がないレスポンスを失敗にする", async () => {
    stubFetchJson({
      url: "https://notion.so/page-id"
    });

    await expect(fetchNotionPageSnapshot(notionSource)).rejects.toThrow(
      "Notion APIレスポンスに last_edited_time がありません"
    );
  });
});
