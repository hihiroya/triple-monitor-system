import { pathToFileURL } from "node:url";
import { loadSources } from "./config.js";
import { logger } from "./logger.js";
import { runSource } from "./source-runner.js";
import { cloneState, loadState, saveState } from "./state.js";
import type { SourceType } from "./types.js";
import { asErrorMessage } from "./utils.js";

const SOURCE_TYPES: readonly SourceType[] = [
  "rss",
  "notion_api_page_poll",
  "public_html_list_poll"
];

/**
 * CLI 引数から監視対象 type の絞り込みを読み取る。
 *
 * workflow は監視タイプごとに分かれているため、ここで type を fail-fast に検証して
 * 意図しない source が混ざって実行されることを防ぐ。
 */
export function parseTypeArg(args: string[]): SourceType | undefined {
  const typeIndex = args.indexOf("--type");
  if (typeIndex === -1) {
    return undefined;
  }

  const value = args[typeIndex + 1];
  if (!value || !SOURCE_TYPES.includes(value as SourceType)) {
    throw new Error(`--type には ${SOURCE_TYPES.join(", ")} のいずれかを指定してください`);
  }
  return value as SourceType;
}

export function parseGroupArg(args: string[]): string | undefined {
  const groupIndex = args.indexOf("--group");
  if (groupIndex === -1) {
    return undefined;
  }

  const value = args[groupIndex + 1];
  if (!value || !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error("--group には小文字英数字、ハイフン、アンダースコアの名前を指定してください");
  }
  return value;
}

/**
 * 監視処理全体を直列に実行する。
 *
 * 1 source の失敗が他 source に波及しないよう、source 単位の結果を集約して最後に
 * exitCode へ反映する。state は runner が更新した内容をまとめて保存する。
 */
export async function runMain(args = process.argv.slice(2)): Promise<void> {
  const filterType = parseTypeArg(args);
  const filterGroup = parseGroupArg(args);
  const sources = await loadSources(filterType, filterGroup);
  const state = await loadState();
  const beforeState = cloneState(state);

  // 3タイプを同じ runner に通すことで、差分管理・通知・失敗時の扱いを一貫させる。
  logger.info(
    `監視対象 source 数: ${sources.length}${filterType ? ` type=${filterType}` : ""}${
      filterGroup ? ` group=${filterGroup}` : ""
    }`
  );

  let hasFailure = false;
  let hasStateChange = false;

  // 外部サイトや API に負荷をかけず、ログの原因追跡もしやすくするため直列で処理する。
  for (const source of sources) {
    logger.info(`source 開始: key=${source.key} type=${source.type}`);
    const result = await runSource(source, state);
    hasStateChange = hasStateChange || result.changed;

    if (!result.ok) {
      hasFailure = true;
      logger.error(`source 失敗: key=${result.key} ${result.message}`);
      continue;
    }

    logger.info(`source 完了: key=${result.key} ${result.message}`);
  }

  if (JSON.stringify(beforeState) !== JSON.stringify(state) || hasStateChange) {
    await saveState(state);
    logger.info("monitor-state.json を保存しました");
  } else {
    logger.info("state 変更はありません");
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}

/**
 * テストから import した時に監視処理が走らないよう、CLI 実行時だけ main を起動する。
 */
function isCliEntryPoint(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;
}

if (isCliEntryPoint()) {
  void runMain().catch((error) => {
    logger.error(`main で致命的エラーが発生しました: ${asErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
