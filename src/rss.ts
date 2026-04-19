import { XMLParser } from "fast-xml-parser";
import type { ListSnapshot, MonitorItem, RssSource } from "./types.js";
import { clampMaxItems, fetchText, normalizeWhitespace } from "./utils.js";

interface ParsedRssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  isoDate?: unknown;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "object" && value !== null && "#text" in value) {
      const text = (value as { "#text"?: unknown })["#text"];
      if (typeof text === "string" && text.trim() !== "") {
        return text.trim();
      }
    }
  }
  return undefined;
}

function extractLink(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const links = value as readonly unknown[];
    const alternateLink = links.find((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const record = entry as Record<string, unknown>;
      return record["@_rel"] === undefined || record["@_rel"] === "alternate";
    });
    return extractLink(alternateLink ?? links[0]);
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const href = record["@_href"];
    if (typeof href === "string" && href.trim() !== "") {
      return href.trim();
    }
    const text = record["#text"];
    if (typeof text === "string" && text.trim() !== "") {
      return text.trim();
    }
  }

  return undefined;
}

function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

/**
 * RSS/Atom の公開フィードから一覧 snapshot を取得する。
 *
 * RSS 2.0 の文字列 link と Atom の href 形式の両方を扱い、link を item ID として
 * 差分判定に使える形へ正規化する。
 */
export async function fetchRssSnapshot(source: RssSource): Promise<ListSnapshot> {
  const xml = await fetchText(source.rssUrl, {
    headers: {
      "User-Agent": "triple-monitor-system/1.0 RSS monitor"
    }
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xml) as unknown;
  } catch (error) {
    throw new Error(
      `RSS XMLの解析に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const root = parsed as {
    rss?: { channel?: { item?: unknown } };
    feed?: { entry?: unknown };
  };
  const rawItems = root.rss?.channel?.item ?? root.feed?.entry;
  const maxItems = clampMaxItems(source.maxItems);

  const items = asArray(rawItems)
    .slice(0, maxItems)
    .map((entry): MonitorItem | undefined => {
      const item = entry as ParsedRssItem;
      const link = extractLink(item.link) ?? firstString(item.guid);
      const title = firstString(item.title) ?? link;
      if (!link || !title) {
        return undefined;
      }

      const monitorItem: MonitorItem = {
        id: link,
        title: normalizeWhitespace(title),
        url: link
      };

      const timestamp = parseTimestamp(firstString(item.pubDate, item.isoDate));
      if (timestamp) {
        monitorItem.timestamp = timestamp;
      }

      return monitorItem;
    })
    .filter((item): item is MonitorItem => item !== undefined);

  if (items.length === 0) {
    throw new Error("RSSから有効な item/link を抽出できませんでした");
  }

  return { kind: "list", items };
}
