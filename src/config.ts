import { readFile } from "node:fs/promises";
import { resolveMonitorPaths } from "./paths.js";
import { validateSources } from "./source-validator.js";
import type { MonitorSource, SourceType } from "./types.js";

/**
 * sources ファイルの読み込み先を返す。
 *
 * `MONITOR_SOURCES_PATH=config/a.json,config/b.json` のように複数指定できる。
 */
export function getSourcesPath(): string {
  const [sourcesPath] = getSourcesPaths();
  if (!sourcesPath) {
    throw new Error("sources path が解決できませんでした");
  }
  return sourcesPath;
}

export function getSourcesPaths(): string[] {
  return resolveMonitorPaths(process.env.MONITOR_SOURCES_PATH, "config");
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readSourcesFile(sourcesPath: string): Promise<MonitorSource[]> {
  let raw: string;
  try {
    raw = await readFile(sourcesPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw new Error(`sources file を読み込めませんでした: ${sourcesPath}`, { cause: error });
  }

  try {
    return validateSources(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`sources file の検証に失敗しました: ${sourcesPath}`, { cause: error });
  }
}

/**
 * 設定ファイルを順に読み込み、同じ key がある場合は後続ファイルの定義を採用する。
 */
export async function loadConfiguredSources(): Promise<MonitorSource[]> {
  const mergedSources = new Map<string, MonitorSource>();

  for (const sourcesPath of getSourcesPaths()) {
    for (const source of await readSourcesFile(sourcesPath)) {
      mergedSources.set(source.key, source);
    }
  }

  return [...mergedSources.values()];
}

/**
 * sources ファイルを読み込み、有効な source だけを返す。
 *
 * workflow ごとの実行では filterType と filterGroup を指定し、該当 source 以外を実行しない。
 */
export async function loadSources(
  filterType?: SourceType,
  filterGroup?: string
): Promise<MonitorSource[]> {
  let enabledSources = (await loadConfiguredSources()).filter((source) => source.enabled);

  if (filterType) {
    enabledSources = enabledSources.filter((source) => source.type === filterType);
  }
  if (filterGroup) {
    enabledSources = enabledSources.filter((source) => source.group === filterGroup);
  }
  return enabledSources;
}
