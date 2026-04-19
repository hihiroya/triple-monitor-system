import type { MonitorItem, NotionPageSource, VersionSnapshot } from "./types.js";
import { asErrorMessage, fetchWithTimeout, getRequiredEnv } from "./utils.js";

interface NotionPageResponse {
  id?: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}

function extractTitle(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) {
    return undefined;
  }

  for (const value of Object.values(properties)) {
    if (typeof value !== "object" || value === null || !("type" in value)) {
      continue;
    }

    const property = value as { type?: unknown; title?: unknown };
    if (property.type !== "title" || !Array.isArray(property.title)) {
      continue;
    }

    const text = property.title
      .map((part) => {
        if (typeof part === "object" && part !== null && "plain_text" in part) {
          const plainText = (part as { plain_text?: unknown }).plain_text;
          return typeof plainText === "string" ? plainText : "";
        }
        return "";
      })
      .join("")
      .trim();

    if (text) {
      return text;
    }
  }

  return undefined;
}

/**
 * Notion retrieve page API からページの version snapshot を取得する。
 *
 * last_edited_time を version として扱うことで、ページ単位の更新有無を単純に比較する。
 * token は環境変数から読み、ログや設定ファイルに直接置かない。
 */
export async function fetchNotionPageSnapshot(source: NotionPageSource): Promise<VersionSnapshot> {
  const token = getRequiredEnv(source.notionTokenEnvName);
  const response = await fetchWithTimeout(`https://api.notion.com/v1/pages/${source.pageId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "User-Agent": "triple-monitor-system/1.0 Notion monitor"
    }
  });

  const body = await response.text();
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryMessage = retryAfter ? ` retryAfter=${retryAfter}s` : "";
    if (response.status === 403) {
      throw new Error(
        `Notion API 権限エラーです。integration が対象ページに招待されているか確認してください。status=403`
      );
    }
    if (response.status === 404) {
      throw new Error(`Notion API でページが見つかりません。pageId を確認してください。status=404`);
    }
    if (response.status === 429) {
      throw new Error(`Notion API の rate limit に達しました。${retryMessage}`);
    }
    throw new Error(`Notion API HTTPエラー: status=${response.status} body=${body.slice(0, 300)}`);
  }

  let page: NotionPageResponse;
  try {
    page = JSON.parse(body) as NotionPageResponse;
  } catch (error) {
    throw new Error(`Notion API JSONの解析に失敗しました: ${asErrorMessage(error)}`, {
      cause: error
    });
  }

  if (!page.last_edited_time) {
    throw new Error("Notion APIレスポンスに last_edited_time がありません");
  }

  const title = extractTitle(page.properties) ?? source.label;
  const item: MonitorItem = {
    id: page.last_edited_time,
    title: `${title} が更新されました`,
    timestamp: page.last_edited_time
  };
  if (page.url) {
    item.url = page.url;
  }

  const snapshot: VersionSnapshot = {
    kind: "version",
    version: page.last_edited_time,
    title: item.title
  };
  if (item.url) {
    snapshot.url = item.url;
  }
  if (item.timestamp) {
    snapshot.timestamp = item.timestamp;
  }
  return snapshot;
}
