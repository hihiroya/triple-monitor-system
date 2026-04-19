import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getSourcesPath } from "./config.js";
import { logger } from "./logger.js";
import { loadState } from "./state.js";
import { validateSources } from "./source-validator.js";
import { asErrorMessage } from "./utils.js";

/**
 * リポジトリに置かれている設定ファイルと state ファイルを検証する。
 *
 * 監視 workflow が動いてから設定ミスに気づくと通知漏れや state 更新失敗に直結するため、
 * CI の品質ゲートで実ファイルを先に検証する。
 */
export async function validateRepositoryFiles(): Promise<void> {
  const rawSources = await readFile(getSourcesPath(), "utf8");
  validateSources(JSON.parse(rawSources) as unknown);
  await loadState();
}

/**
 * テストから import した時に検証処理が走らないよう、CLI 実行時だけ起動する。
 */
function isCliEntryPoint(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;
}

if (isCliEntryPoint()) {
  void validateRepositoryFiles()
    .then(() => {
      logger.info("config/sources.json と state/monitor-state.json の検証に成功しました");
    })
    .catch((error) => {
      logger.error(`設定ファイル検証に失敗しました: ${asErrorMessage(error)}`);
      process.exitCode = 1;
    });
}
