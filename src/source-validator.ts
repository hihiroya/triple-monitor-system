import type {
  MonitorSource,
  PublicHtmlListSource,
  RssSource,
  SelectorStrategyName,
  SourceType
} from "./types.js";

const SOURCE_TYPES: readonly SourceType[] = [
  "rss",
  "notion_api_page_poll",
  "public_html_list_poll"
];
const SELECTOR_STRATEGIES: readonly SelectorStrategyName[] = ["revuestarlight_news_list"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} は空でない文字列である必要があります`);
  }
  return value.trim();
}

function requireEnvName(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error(
      `${field} は GitHub Secrets に使いやすい大文字英数字とアンダースコアの名前にしてください`
    );
  }
  return value;
}

function optionalGroup(record: Record<string, unknown>): string | undefined {
  const value = record.group;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error("group は小文字英数字、ハイフン、アンダースコアで指定してください");
  }
  return value;
}

function requireHttpUrl(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} は有効な URL である必要があります`);
  }

  // GitHub Actions から取得する外部入力は HTTP(S) に限定し、意図しない scheme を避ける。
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} は http または https URL である必要があります`);
  }
  return url.toString();
}

function requireNotionPageId(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field).replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new Error(`${field} は 32 桁の Notion page ID である必要があります`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`${field} は boolean である必要があります`);
  }
  return value;
}

function optionalMaxItems(record: Record<string, unknown>): number | undefined {
  const value = record.maxItems;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("maxItems は 1 以上 100 以下の整数である必要があります");
  }
  return value;
}

/**
 * sources.json の外部入力を MonitorSource 配列へ検証・正規化する。
 *
 * URL、環境変数名、selectorStrategy を fail-fast で検証し、危険な scheme や
 * 未許可 strategy が GitHub Actions 上で実行されることを防ぐ。
 */
export function validateSources(value: unknown): MonitorSource[] {
  if (!Array.isArray(value)) {
    throw new Error("sources.json のトップレベルは配列である必要があります");
  }

  const seenKeys = new Set<string>();
  return value.map((entry, index) => validateSource(entry, index, seenKeys));
}

function validateSource(value: unknown, index: number, seenKeys: Set<string>): MonitorSource {
  if (!isRecord(value)) {
    throw new Error(`sources[${index}] は object である必要があります`);
  }

  const key = requireString(value, "key");
  if (seenKeys.has(key)) {
    throw new Error(`source key が重複しています: ${key}`);
  }
  seenKeys.add(key);

  const rawType = requireString(value, "type");
  if (!SOURCE_TYPES.includes(rawType as SourceType)) {
    throw new Error(`未対応の source type です: ${rawType}`);
  }

  const group = optionalGroup(value);
  const common = {
    key,
    type: rawType as SourceType,
    label: requireString(value, "label"),
    webhookEnvName: requireEnvName(value, "webhookEnvName"),
    enabled: requireBoolean(value, "enabled")
  };
  const commonWithGroup = group === undefined ? common : { ...common, group };

  if (commonWithGroup.type === "rss") {
    const source: RssSource = {
      ...commonWithGroup,
      type: "rss",
      rssUrl: requireHttpUrl(value, "rssUrl")
    };
    const maxItems = optionalMaxItems(value);
    return maxItems === undefined ? source : { ...source, maxItems };
  }

  if (commonWithGroup.type === "notion_api_page_poll") {
    return {
      ...commonWithGroup,
      type: "notion_api_page_poll",
      pageId: requireNotionPageId(value, "pageId"),
      notionTokenEnvName: requireEnvName(value, "notionTokenEnvName")
    };
  }

  const strategy = requireString(value, "selectorStrategy");
  if (!SELECTOR_STRATEGIES.includes(strategy as SelectorStrategyName)) {
    throw new Error(`未許可の selectorStrategy です: ${strategy}`);
  }

  const source: PublicHtmlListSource = {
    ...commonWithGroup,
    type: "public_html_list_poll",
    url: requireHttpUrl(value, "url"),
    selectorStrategy: strategy as SelectorStrategyName
  };
  const maxItems = optionalMaxItems(value);
  return maxItems === undefined ? source : { ...source, maxItems };
}
