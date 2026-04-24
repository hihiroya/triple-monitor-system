import type { ListSnapshot, PublicHtmlListSource } from "./types.js";
import { buildPaginationUrls } from "./pagination-strategies.js";
import { runSelectorStrategy } from "./selector-strategies.js";
import { clampMaxItems, fetchText } from "./utils.js";

/**
 * 公開 HTML の一覧ページから list snapshot を取得する。
 *
 * HTML 監視はサイト改修で壊れやすいため、抽出処理は selector strategy に委譲し、
 * 0 件抽出は静かな成功ではなく source 失敗として扱う。
 */
export async function fetchPublicHtmlSnapshot(source: PublicHtmlListSource): Promise<ListSnapshot> {
  const maxItems = clampMaxItems(source.maxItems);
  const pageUrls = buildPaginationUrls(source.url, source.pagination);
  const items: ListSnapshot["items"] = [];
  const seen = new Set<string>();

  for (const pageUrl of pageUrls) {
    if (items.length >= maxItems) {
      break;
    }

    const html = await fetchText(pageUrl, {
      headers: {
        "User-Agent": "triple-monitor-system/1.0 public HTML monitor"
      }
    });

    const pageItems = runSelectorStrategy(
      source.selectorStrategy,
      html,
      pageUrl,
      maxItems - items.length
    );

    for (const item of pageItems) {
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      items.push(item);
      if (items.length >= maxItems) {
        break;
      }
    }
  }

  if (items.length === 0) {
    throw new Error(
      `HTML一覧から記事リンクを抽出できませんでした: strategy=${source.selectorStrategy}`
    );
  }

  return { kind: "list", items };
}
