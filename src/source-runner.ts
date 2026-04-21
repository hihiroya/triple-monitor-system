import { notifyDiscord } from "./discord.js";
import { fetchNotionDatabaseSnapshot, fetchNotionPageSnapshot } from "./notion.js";
import { fetchPublicHtmlSnapshot } from "./public-html.js";
import { fetchRssSnapshot } from "./rss.js";
import { logger } from "./logger.js";
import type {
  MonitorItem,
  MonitorSource,
  MonitorState,
  SourceRunResult,
  SourceSnapshot
} from "./types.js";
import { asErrorMessage } from "./utils.js";

const SEEN_ITEM_HISTORY_LIMIT = 50;

/**
 * source type に応じて現在の監視結果を取得する。
 *
 * 差分判定や通知制御は runner 側へ集約し、各監視モジュールは取得と抽出に集中させる。
 */
async function fetchSnapshot(source: MonitorSource): Promise<SourceSnapshot> {
  if (source.type === "rss") {
    return fetchRssSnapshot(source);
  }
  if (source.type === "notion_api_page_poll") {
    return fetchNotionPageSnapshot(source);
  }
  if (source.type === "notion_api_database_poll") {
    return fetchNotionDatabaseSnapshot(source);
  }
  return fetchPublicHtmlSnapshot(source);
}

/**
 * Notion の version snapshot を Discord 通知用 item に変換する。
 */
function buildVersionItem(snapshot: Extract<SourceSnapshot, { kind: "version" }>): MonitorItem {
  const item: MonitorItem = {
    id: snapshot.version,
    title: snapshot.title
  };
  if (snapshot.url) {
    item.url = snapshot.url;
  }
  if (snapshot.timestamp) {
    item.timestamp = snapshot.timestamp;
  }
  return item;
}

/**
 * 旧 state と新 state の両方に対応するため、lastSeenItemId と seenItemIds を統合する。
 */
function normalizeSeenItemIds(
  lastSeenItemId: string | undefined,
  seenItemIds: string[] | undefined
): string[] {
  const result: string[] = [];
  for (const itemId of [lastSeenItemId, ...(seenItemIds ?? [])]) {
    if (itemId && !result.includes(itemId)) {
      result.push(itemId);
    }
  }
  return result.slice(0, SEEN_ITEM_HISTORY_LIMIT);
}

/**
 * 直近に観測した item ID を履歴として保存する。
 *
 * RSS/HTML は取得順や一覧件数が揺れるため、単一の lastSeenItemId だけに依存しすぎない。
 */
function rememberSeenItems(newestItemIds: string[], previousSeenItemIds: string[]): string[] {
  const result: string[] = [];
  for (const itemId of [...newestItemIds, ...previousSeenItemIds]) {
    if (!result.includes(itemId)) {
      result.push(itemId);
    }
  }
  return result.slice(0, SEEN_ITEM_HISTORY_LIMIT);
}

function filterAlreadySeenItemIds(itemIds: string[], previousSeenItemIds: string[]): string[] {
  const seen = new Set(previousSeenItemIds);
  return itemIds.filter((itemId) => seen.has(itemId));
}

function formatLogItemId(itemId: string | undefined): string {
  if (!itemId) {
    return "(none)";
  }
  return itemId.length > 160 ? `${itemId.slice(0, 157)}...` : itemId;
}

function formatLogItemIds(itemIds: string[]): string {
  if (itemIds.length === 0) {
    return "(none)";
  }
  return itemIds.map(formatLogItemId).join(",");
}

/**
 * 取得結果から未通知 item を古い順に返す。
 *
 * 既読履歴と交差しない場合は、取得窓落ちやサイト構造変更の可能性があるため、
 * 全件通知ではなく失敗にして重複通知を避ける。
 */
function findNewItems(items: MonitorItem[], seenItemIds: string[]): MonitorItem[] {
  if (seenItemIds.length === 0) {
    return [];
  }

  const seen = new Set(seenItemIds);
  const hasSeenIntersection = items.some((item) => seen.has(item.id));
  if (!hasSeenIntersection) {
    // 既読履歴と取得結果が交差しない場合は、順序変更や取得窓落ちの疑いがある。
    // 全件通知すると重複通知になり得るため、運用者が確認できるよう source 失敗にする。
    throw new Error(
      "既読 item が取得結果に見つかりません。maxItems、取得順、対象サイトの構造変更を確認してください"
    );
  }

  return items.filter((item) => !seen.has(item.id)).reverse();
}

/**
 * source 単位で監視を実行し、差分通知と state 更新を行う。
 *
 * この関数で例外を SourceRunResult に変換することで、1 source の失敗を main 側で
 * 集約しつつ、他 source の監視を継続できる。
 */
export async function runSource(
  source: MonitorSource,
  state: MonitorState
): Promise<SourceRunResult> {
  try {
    const snapshot = await fetchSnapshot(source);
    const sourceState = state.sources[source.key] ?? {};

    if (snapshot.kind === "list") {
      return await runListSource(
        source,
        state,
        snapshot.items,
        sourceState.lastSeenItemId,
        sourceState.seenItemIds
      );
    }

    return await runVersionSource(source, state, snapshot, sourceState.lastSeenVersion);
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      changed: false,
      message: asErrorMessage(error)
    };
  }
}

/**
 * RSS/HTML の一覧型 source を処理する。
 *
 * 初回は過去記事の大量通知を避けるため baseline 保存のみ行い、2 回目以降は
 * 通知に成功した item だけを既読履歴へ反映する。
 */
async function runListSource(
  source: MonitorSource,
  state: MonitorState,
  items: MonitorItem[],
  lastSeenItemId: string | undefined,
  seenItemIds: string[] | undefined
): Promise<SourceRunResult> {
  const latestItem = items[0];
  if (!latestItem) {
    throw new Error("監視結果に item がありません");
  }

  const itemIds = items.map((item) => item.id);
  const previousSeenItemIds = normalizeSeenItemIds(lastSeenItemId, seenItemIds);
  const alreadySeenItemIds = filterAlreadySeenItemIds(itemIds, previousSeenItemIds);

  logger.info(
    `list snapshot: key=${source.key} items=${items.length} latest=${formatLogItemId(
      latestItem.id
    )} previousSeen=${previousSeenItemIds.length} seenIntersection=${
      alreadySeenItemIds.length
    } sample=${formatLogItemIds(itemIds.slice(0, 10))}`
  );

  if (!lastSeenItemId) {
    // 初回通知は過去記事の大量通知を避けるため行わず、現在位置だけを記録する。
    state.sources[source.key] = {
      lastSeenItemId: latestItem.id,
      seenItemIds: itemIds.slice(0, SEEN_ITEM_HISTORY_LIMIT)
    };
    return {
      key: source.key,
      ok: true,
      changed: true,
      message: "初回実行のため通知せずベースラインを保存しました"
    };
  }

  const newItems = findNewItems(items, previousSeenItemIds);
  logger.info(
    `list diff: key=${source.key} newItems=${newItems.length} firstNew=${formatLogItemId(
      newItems[0]?.id
    )}`
  );

  if (newItems.length === 0) {
    state.sources[source.key] = {
      lastSeenItemId,
      seenItemIds: rememberSeenItems(previousSeenItemIds, alreadySeenItemIds)
    };
    return {
      key: source.key,
      ok: true,
      changed: false,
      message: "新着はありません"
    };
  }

  let currentSeenItemIds = previousSeenItemIds;
  for (const item of newItems) {
    await notifyDiscord(source, item);
    // state は通知成功後だけ進める。途中失敗時に未通知 item を既読扱いしないため。
    currentSeenItemIds = rememberSeenItems([item.id], currentSeenItemIds);
    state.sources[source.key] = {
      lastSeenItemId: item.id,
      seenItemIds: currentSeenItemIds
    };
  }

  state.sources[source.key] = {
    lastSeenItemId: latestItem.id,
    seenItemIds: rememberSeenItems(currentSeenItemIds, alreadySeenItemIds)
  };

  return {
    key: source.key,
    ok: true,
    changed: true,
    message: `${newItems.length} 件通知しました`
  };
}

/**
 * Notion のような単一 version 型 source を処理する。
 *
 * version は一覧型と違って履歴を持たず、通知成功後にだけ lastSeenVersion を進める。
 */
async function runVersionSource(
  source: MonitorSource,
  state: MonitorState,
  snapshot: Extract<SourceSnapshot, { kind: "version" }>,
  lastSeenVersion: string | undefined
): Promise<SourceRunResult> {
  if (!lastSeenVersion) {
    // 初回は「どこから監視を始めるか」を記録するだけにして、既存更新の通知を抑制する。
    state.sources[source.key] = { lastSeenVersion: snapshot.version };
    return {
      key: source.key,
      ok: true,
      changed: true,
      message: "初回実行のため通知せずベースラインを保存しました"
    };
  }

  if (snapshot.version === lastSeenVersion) {
    return {
      key: source.key,
      ok: true,
      changed: false,
      message: "更新はありません"
    };
  }

  await notifyDiscord(source, buildVersionItem(snapshot));
  // Notion の last_edited_time も通知成功後だけ更新し、失敗時の取りこぼしを避ける。
  state.sources[source.key] = { lastSeenVersion: snapshot.version };

  return {
    key: source.key,
    ok: true,
    changed: true,
    message: "更新を通知しました"
  };
}
