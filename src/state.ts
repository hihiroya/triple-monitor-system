import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MonitorState, SourceState } from "./types.js";

/**
 * state ファイルの保存先を返す。
 *
 * 通常運用ではリポジトリ内の state を使い、テストでは環境変数で一時パスへ逃がす。
 */
function getStatePath(): string {
  return path.resolve(process.env.MONITOR_STATE_PATH ?? path.join("state", "monitor-state.json"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateState(value: unknown): MonitorState {
  if (!isRecord(value) || !isRecord(value.sources)) {
    throw new Error("monitor-state.json は { sources: {} } 形式である必要があります");
  }

  const sources: Record<string, SourceState> = {};
  for (const [key, state] of Object.entries(value.sources)) {
    if (!isRecord(state)) {
      throw new Error(`state.sources.${key} は object である必要があります`);
    }

    const sourceState: SourceState = {};
    if (typeof state.lastSeenItemId === "string") {
      sourceState.lastSeenItemId = state.lastSeenItemId;
    }
    if (Array.isArray(state.seenItemIds)) {
      sourceState.seenItemIds = state.seenItemIds.filter(
        (itemId): itemId is string => typeof itemId === "string"
      );
    }
    if (typeof state.lastSeenVersion === "string") {
      sourceState.lastSeenVersion = state.lastSeenVersion;
    }
    sources[key] = sourceState;
  }

  return { sources };
}

/**
 * monitor-state.json を読み込む。
 *
 * state がまだ存在しない初回実行では空 state を返し、壊れた JSON や不正形式は
 * 監視の安全性を優先して失敗させる。
 */
export async function loadState(): Promise<MonitorState> {
  try {
    const raw = await readFile(getStatePath(), "utf8");
    return validateState(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { sources: {} };
    }
    throw error;
  }
}

/**
 * monitor-state.json を保存する。
 *
 * state は既読管理の根拠なので、直接上書きせず一時ファイルを書き切ってから
 * rename で入れ替える。これにより、書き込み中断で壊れた JSON が残るリスクを下げる。
 */
export async function saveState(state: MonitorState): Promise<void> {
  const statePath = getStatePath();
  await mkdir(path.dirname(statePath), { recursive: true });
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(tempPath, body, "utf8");
    await rename(tempPath, statePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * state の変更有無を比較するため、JSON として扱える範囲で deep clone する。
 */
export function cloneState(state: MonitorState): MonitorState {
  return JSON.parse(JSON.stringify(state)) as MonitorState;
}
