export type SourceType =
  | "rss"
  | "x_profile_poll"
  | "notion_api_page_poll"
  | "notion_api_database_poll"
  | "public_html_list_poll";

export interface BaseSource {
  key: string;
  type: SourceType;
  label: string;
  webhookEnvName: string;
  enabled: boolean;
  group?: string;
}

export interface RssSource extends BaseSource {
  type: "rss";
  rssUrl: string;
  maxItems?: number;
}

export interface XProfileSource extends BaseSource {
  type: "x_profile_poll";
  screenName: string;
  xAuthTokenEnvName: string;
  maxItems?: number;
  maxAgeHours?: number;
  includeRetweets?: boolean;
}

export interface NotionPageSource extends BaseSource {
  type: "notion_api_page_poll";
  pageId: string;
  notionTokenEnvName: string;
}

export interface NotionDatabaseSource extends BaseSource {
  type: "notion_api_database_poll";
  databaseId: string;
  notionTokenEnvName: string;
}

export type SelectorStrategyName = "revuestarlight_news_list";

export interface PublicHtmlListSource extends BaseSource {
  type: "public_html_list_poll";
  url: string;
  maxItems?: number;
  selectorStrategy: SelectorStrategyName;
}

export type MonitorSource =
  | RssSource
  | XProfileSource
  | NotionPageSource
  | NotionDatabaseSource
  | PublicHtmlListSource;

export interface MonitorItem {
  id: string;
  title: string;
  url?: string;
  timestamp?: string;
}

export interface ListSnapshot {
  kind: "list";
  items: MonitorItem[];
}

export interface VersionSnapshot {
  kind: "version";
  version: string;
  title: string;
  url?: string;
  timestamp?: string;
}

export type SourceSnapshot = ListSnapshot | VersionSnapshot;

export interface SourceState {
  lastSeenItemId?: string;
  seenItemIds?: string[];
  lastSeenVersion?: string;
}

export interface MonitorState {
  sources: Record<string, SourceState>;
}

export interface SourceRunResult {
  key: string;
  ok: boolean;
  changed: boolean;
  message: string;
}
