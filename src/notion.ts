import type {
  MonitorItem,
  NotionDatabaseSource,
  NotionPageSource,
  VersionSnapshot
} from "./types.js";
import { asErrorMessage, fetchWithTimeout, getRequiredEnv } from "./utils.js";

interface NotionPageResponse {
  id?: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}

interface NotionDatabaseResponse {
  id?: string;
  url?: string;
  last_edited_time?: string;
  title?: unknown;
}

type NotionVersionSource = NotionPageSource | NotionDatabaseSource;

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

function extractRichTextPlainText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((part) => {
      if (typeof part === "object" && part !== null && "plain_text" in part) {
        const plainText = (part as { plain_text?: unknown }).plain_text;
        return typeof plainText === "string" ? plainText : "";
      }
      return "";
    })
    .join("")
    .trim();

  return text || undefined;
}

function buildSnapshot(
  source: NotionVersionSource,
  response: { url?: string; last_edited_time?: string },
  title: string | undefined
): VersionSnapshot {
  if (!response.last_edited_time) {
    throw new Error("Notion APIレスポンスに last_edited_time がありません");
  }

  const item: MonitorItem = {
    id: response.last_edited_time,
    title: `${title ?? source.label} が更新されました`,
    timestamp: response.last_edited_time
  };
  if (response.url) {
    item.url = response.url;
  }

  const snapshot: VersionSnapshot = {
    kind: "version",
    version: response.last_edited_time,
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

function explainNotionHttpError(response: Response, body: string, targetLabel: string): Error {
  const retryAfter = response.headers.get("retry-after");
  const retryMessage = retryAfter ? ` retryAfter=${retryAfter}s` : "";
  if (response.status === 403) {
    return new Error(
      `Notion API 権限エラーです。integration が対象${targetLabel}に招待されているか確認してください。status=403`
    );
  }
  if (response.status === 404) {
    return new Error(
      `Notion API で${targetLabel}が見つかりません。ID を確認してください。status=404`
    );
  }
  if (response.status === 429) {
    return new Error(`Notion API の rate limit に達しました。${retryMessage}`);
  }
  return new Error(`Notion API HTTPエラー: status=${response.status} body=${body.slice(0, 300)}`);
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
    throw explainNotionHttpError(response, body, "ページ");
  }

  let page: NotionPageResponse;
  try {
    page = JSON.parse(body) as NotionPageResponse;
  } catch (error) {
    throw new Error(`Notion API JSONの解析に失敗しました: ${asErrorMessage(error)}`, {
      cause: error
    });
  }

  return buildSnapshot(source, page, extractTitle(page.properties));
}

/**
 * Notion retrieve database API からデータベースの version snapshot を取得する。
 *
 * Notion は database ID を retrieve page API に渡すと validation_error を返すため、
 * page と database を source type で分けて正しい API を呼び出す。
 */
export async function fetchNotionDatabaseSnapshot(
  source: NotionDatabaseSource
): Promise<VersionSnapshot> {
  const token = getRequiredEnv(source.notionTokenEnvName);
  const response = await fetchWithTimeout(
    `https://api.notion.com/v1/databases/${source.databaseId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "User-Agent": "triple-monitor-system/1.0 Notion monitor"
      }
    }
  );

  const body = await response.text();
  if (!response.ok) {
    throw explainNotionHttpError(response, body, "データベース");
  }

  let database: NotionDatabaseResponse;
  try {
    database = JSON.parse(body) as NotionDatabaseResponse;
  } catch (error) {
    throw new Error(`Notion API JSONの解析に失敗しました: ${asErrorMessage(error)}`, {
      cause: error
    });
  }

  return buildSnapshot(source, database, extractRichTextPlainText(database.title));
}
