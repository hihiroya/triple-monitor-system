import type { ListSnapshot, PublicHtmlListSource } from "./types.js";
import { runSelectorStrategy } from "./selector-strategies.js";
import { clampMaxItems, fetchText } from "./utils.js";

/**
 * 公開 HTML の一覧ページから list snapshot を取得する。
 *
 * HTML 監視はサイト改修で壊れやすいため、抽出処理は selector strategy に委譲し、
 * 0 件抽出は静かな成功ではなく source 失敗として扱う。
 */
export async function fetchPublicHtmlSnapshot(source: PublicHtmlListSource): Promise<ListSnapshot> {
  const html = await fetchText(source.url, {
    headers: {
      "User-Agent": "triple-monitor-system/1.0 public HTML monitor"
    }
  });

  const maxItems = clampMaxItems(source.maxItems);
  const items = runSelectorStrategy(source.selectorStrategy, html, source.url, maxItems);

  if (items.length === 0) {
    throw new Error(
      `HTML一覧から記事リンクを抽出できませんでした: strategy=${source.selectorStrategy}`
    );
  }

  return { kind: "list", items };
}
