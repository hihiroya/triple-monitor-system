import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateSources } from "./source-validator.js";
import type { MonitorSource, SourceType } from "./types.js";

/**
 * sources.json の読み込み先を返す。
 *
 * 通常運用ではリポジトリ内の config を使い、CLI smoke test では環境変数で
 * 一時ファイルへ差し替える。
 */
export function getSourcesPath(): string {
  return path.resolve(process.env.MONITOR_SOURCES_PATH ?? path.join("config", "sources.json"));
}

/**
 * sources.json を読み込み、有効な source だけを返す。
 *
 * workflow ごとの実行では filterType と filterGroup を指定し、該当 source 以外を実行しない。
 */
export async function loadSources(
  filterType?: SourceType,
  filterGroup?: string
): Promise<MonitorSource[]> {
  const raw = await readFile(getSourcesPath(), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const sources = validateSources(parsed);
  let enabledSources = sources.filter((source) => source.enabled);

  if (filterType) {
    enabledSources = enabledSources.filter((source) => source.type === filterType);
  }
  if (filterGroup) {
    enabledSources = enabledSources.filter((source) => source.group === filterGroup);
  }
  return enabledSources;
}
