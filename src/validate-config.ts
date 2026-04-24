import { pathToFileURL } from "node:url";
import { loadConfiguredSources } from "./config.js";
import { logger } from "./logger.js";
import { loadState } from "./state.js";
import { asErrorMessage } from "./utils.js";

const REPOSITORY_SOURCES_PATHS = "config/default-sources.json,config/tourism-sources.json";
const REPOSITORY_STATE_PATHS = ["state/default-state.json", "state/tourism-state.json"] as const;

async function withTemporaryEnv<T>(
  name: string,
  value: string,
  action: () => Promise<T>
): Promise<T> {
  const originalValue = process.env[name];
  process.env[name] = value;
  try {
    return await action();
  } finally {
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
}

/**
 * リポジトリに置かれている設定ファイルと state ファイルを検証する。
 *
 * 監視 workflow が動いてから設定ミスに気づくと通知漏れや state 更新失敗に直結するため、
 * CI の品質ゲートで実ファイルを先に検証する。
 */
export async function validateRepositoryFiles(): Promise<void> {
  if (process.env.MONITOR_SOURCES_PATH) {
    await loadConfiguredSources();
  } else {
    await withTemporaryEnv("MONITOR_SOURCES_PATH", REPOSITORY_SOURCES_PATHS, loadConfiguredSources);
  }

  if (process.env.MONITOR_STATE_PATH) {
    await loadState();
    return;
  }

  for (const statePath of REPOSITORY_STATE_PATHS) {
    await withTemporaryEnv("MONITOR_STATE_PATH", statePath, loadState);
  }
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
      logger.info("monitor sources と monitor state の検証に成功しました");
    })
    .catch((error) => {
      logger.error(`設定ファイル検証に失敗しました: ${asErrorMessage(error)}`);
      process.exitCode = 1;
    });
}
