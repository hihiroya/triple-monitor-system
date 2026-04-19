import * as cheerio from "cheerio";
import type { MonitorItem, SelectorStrategyName } from "./types.js";
import { normalizeWhitespace, toAbsoluteUrl } from "./utils.js";

type SelectorStrategy = (html: string, baseUrl: string, maxItems: number) => MonitorItem[];

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

const STRATEGIES: Record<SelectorStrategyName, SelectorStrategy> = {
  revuestarlight_news_list: revuestarlightNewsList
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
