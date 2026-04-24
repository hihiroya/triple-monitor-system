import * as cheerio from "cheerio";
import type { MonitorItem, SelectorStrategyName } from "./types.js";
import { normalizeWhitespace, toAbsoluteUrl } from "./utils.js";

type SelectorStrategy = (html: string, baseUrl: string, maxItems: number) => MonitorItem[];

interface ScopedAnchorRule {
  itemSelector: string;
  hrefPrefix: string;
  titleSelector?: string;
}

interface JsonLdListItem {
  item?: unknown;
}

interface JsonLdEvent {
  "@type"?: unknown;
  name?: unknown;
  url?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

interface JsonLdItemList {
  "@type"?: unknown;
  itemListElement?: unknown;
}

function collectScopedAnchorItems(
  html: string,
  baseUrl: string,
  maxItems: number,
  rule: ScopedAnchorRule
): MonitorItem[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: MonitorItem[] = [];

  $(rule.itemSelector).each((_, element) => {
    if (items.length >= maxItems) {
      return false;
    }

    const container = $(element);
    const link = container.find(`a[href^="${rule.hrefPrefix}"]`).first();
    const href = link.attr("href");
    if (!href) {
      return;
    }

    const absoluteUrl = toAbsoluteUrl(href, baseUrl);
    if (!absoluteUrl || seen.has(absoluteUrl)) {
      return;
    }

    const titleSource =
      rule.titleSelector === undefined ? link : container.find(rule.titleSelector).first();
    const title = normalizeWhitespace(titleSource.text()) || normalizeWhitespace(link.text());
    if (!title) {
      return;
    }

    seen.add(absoluteUrl);
    items.push({
      id: absoluteUrl,
      title,
      url: absoluteUrl
    });
  });

  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isItemList(value: unknown): value is JsonLdItemList {
  if (!isRecord(value)) {
    return false;
  }

  return asArray(value["@type"]).includes("ItemList");
}

function collectJsonLdItemLists(value: unknown): JsonLdItemList[] {
  const lists: JsonLdItemList[] = [];

  for (const entry of asArray(value)) {
    if (isItemList(entry)) {
      lists.push(entry);
      continue;
    }

    if (isRecord(entry) && "@graph" in entry) {
      lists.push(...collectJsonLdItemLists(entry["@graph"]));
    }
  }

  return lists;
}

function parseJsonLdItemLists(html: string): JsonLdItemList[] {
  const $ = cheerio.load(html);
  const lists: JsonLdItemList[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const rawJson = $(element).text().trim();
    if (!rawJson) {
      return;
    }

    try {
      lists.push(...collectJsonLdItemLists(JSON.parse(rawJson) as unknown));
    } catch {
      // 壊れた JSON-LD は他の script block の抽出を妨げない。
    }
  });

  return lists;
}

function revuestarlightNewsList(html: string, baseUrl: string, maxItems: number): MonitorItem[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const items: MonitorItem[] = [];

  // HTML監視はサイト改修に弱いため、広めの候補から安全に記事リンクだけを採用する。
  $("a[href]").each((_, element) => {
    if (items.length >= maxItems) {
      return false;
    }

    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    const absoluteUrl = toAbsoluteUrl(href, baseUrl);
    if (!absoluteUrl || seen.has(absoluteUrl)) {
      return;
    }

    const url = new URL(absoluteUrl);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith("/news/") ||
      url.pathname === "/news/"
    ) {
      return;
    }

    const title = normalizeWhitespace($(element).text());
    if (!title) {
      return;
    }

    seen.add(absoluteUrl);
    items.push({
      id: absoluteUrl,
      title,
      url: absoluteUrl
    });
  });

  return items;
}

function walkerplusEventList(html: string, baseUrl: string, maxItems: number): MonitorItem[] {
  return collectScopedAnchorItems(html, baseUrl, maxItems, {
    itemSelector: ".m-mainlist__list > li.m-mainlist__item",
    hrefPrefix: "/event/",
    titleSelector: ".m-mainlist-item__ttl"
  });
}

function enjoytokyoEventList(html: string, baseUrl: string, maxItems: number): MonitorItem[] {
  const seen = new Set<string>();
  const items: MonitorItem[] = [];

  for (const list of parseJsonLdItemLists(html)) {
    for (const listItem of asArray(list.itemListElement) as JsonLdListItem[]) {
      if (items.length >= maxItems) {
        return items;
      }
      if (!isRecord(listItem) || !isRecord(listItem.item)) {
        continue;
      }

      const event = listItem.item as JsonLdEvent;
      if (event["@type"] !== "Event" || typeof event.name !== "string") {
        continue;
      }
      if (typeof event.url !== "string") {
        continue;
      }

      const absoluteUrl = toAbsoluteUrl(event.url, baseUrl);
      if (!absoluteUrl || seen.has(absoluteUrl)) {
        continue;
      }

      const titleParts = [event.name];
      if (typeof event.startDate === "string") {
        titleParts.push(event.startDate);
      }
      if (typeof event.endDate === "string" && event.endDate !== event.startDate) {
        titleParts.push(`- ${event.endDate}`);
      }

      seen.add(absoluteUrl);
      items.push({
        id: absoluteUrl,
        title: normalizeWhitespace(titleParts.join(" ")),
        url: absoluteUrl
      });
    }
  }

  return items;
}

function artscapeExhibitionList(html: string, baseUrl: string, maxItems: number): MonitorItem[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: MonitorItem[] = [];

  $("article.item-article.item-exhibitions").each((_, element) => {
    if (items.length >= maxItems) {
      return false;
    }

    const container = $(element);
    const link = container.find("h3.article-title a[href]").first();
    const href = link.attr("href");
    if (!href) {
      return;
    }

    const absoluteUrl = toAbsoluteUrl(href, baseUrl);
    if (!absoluteUrl || seen.has(absoluteUrl)) {
      return;
    }

    const url = new URL(absoluteUrl);
    if (url.origin !== "https://artscape.jp" || !/^\/exhibitions\/\d+\/$/.test(url.pathname)) {
      return;
    }

    const title = normalizeWhitespace(link.text());
    if (!title) {
      return;
    }

    const period = container
      .find("p")
      .toArray()
      .map((node) => normalizeWhitespace($(node).text()))
      .find((text) => text.startsWith("会期："));

    seen.add(absoluteUrl);
    items.push({
      id: absoluteUrl,
      title: period ? `${title} ${period}` : title,
      url: absoluteUrl
    });
  });

  return items;
}

const STRATEGIES: Record<SelectorStrategyName, SelectorStrategy> = {
  revuestarlight_news_list: revuestarlightNewsList,
  walkerplus_event_list: walkerplusEventList,
  enjoytokyo_event_list: enjoytokyoEventList,
  artscape_exhibition_list: artscapeExhibitionList
};

/**
 * 許可済み selector strategy を実行する。
 *
 * sources.json の文字列をそのまま CSS selector として使わず、ホワイトリスト済み関数に
 * マッピングすることで、サイト固有の抽出ロジックを安全に分離する。
 */
export function runSelectorStrategy(
  strategyName: SelectorStrategyName,
  html: string,
  baseUrl: string,
  maxItems: number
): MonitorItem[] {
  // selectorStrategy は外部入力をそのまま CSS に使わず、許可済み関数だけに分岐する。
  const strategy = STRATEGIES[strategyName];
  return strategy(html, baseUrl, maxItems);
}
