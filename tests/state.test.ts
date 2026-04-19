import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneState, loadState, saveState } from "../src/state.js";
import type { MonitorState } from "../src/types.js";

let tempDir: string;
let statePath: string;

describe("state", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "triple-monitor-state-"));
    statePath = path.join(tempDir, "monitor-state.json");
    process.env.MONITOR_STATE_PATH = statePath;
  });

  afterEach(async () => {
    delete process.env.MONITOR_STATE_PATH;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("state ファイルがない場合は空 state を返す", async () => {
    await expect(loadState()).resolves.toEqual({ sources: {} });
  });

  it("既存 state を読み込み、seenItemIds は文字列だけに正規化する", async () => {
    await writeFile(
      statePath,
      JSON.stringify({
        sources: {
          rss: {
            lastSeenItemId: "latest",
            seenItemIds: ["latest", 123, "old", null],
            lastSeenVersion: 999
          },
          notion: {
            lastSeenVersion: "2026-04-19T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );

    await expect(loadState()).resolves.toEqual({
      sources: {
        rss: {
          lastSeenItemId: "latest",
          seenItemIds: ["latest", "old"]
        },
        notion: {
          lastSeenVersion: "2026-04-19T00:00:00.000Z"
        }
      }
    });
  });

  it("壊れた JSON を失敗にする", async () => {
    await writeFile(statePath, "{invalid json", "utf8");

    await expect(loadState()).rejects.toThrow();
  });

  it("不正な state 形式を失敗にする", async () => {
    await writeFile(statePath, JSON.stringify({ sources: [] }), "utf8");

    await expect(loadState()).rejects.toThrow(
      "monitor-state.json は { sources: {} } 形式である必要があります"
    );
  });

  it("state を pretty JSON として保存する", async () => {
    const state: MonitorState = {
      sources: {
        rss: {
          lastSeenItemId: "latest",
          seenItemIds: ["latest", "old"]
        }
      }
    };

    await saveState(state);

    await expect(readFile(statePath, "utf8")).resolves.toBe(`${JSON.stringify(state, null, 2)}\n`);
  });

  it("保存後に一時ファイルを残さない", async () => {
    await saveState({ sources: {} });

    const files = await import("node:fs/promises").then(({ readdir }) => readdir(tempDir));
    expect(files).toEqual(["monitor-state.json"]);
  });

  it("cloneState は元 state と独立した deep clone を返す", () => {
    const state: MonitorState = {
      sources: {
        rss: {
          lastSeenItemId: "latest",
          seenItemIds: ["latest"]
        }
      }
    };

    const cloned = cloneState(state);
    cloned.sources.rss?.seenItemIds?.push("new");

    expect(state.sources.rss?.seenItemIds).toEqual(["latest"]);
    expect(cloned.sources.rss?.seenItemIds).toEqual(["latest", "new"]);
  });
});
