import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSourcesPath,
  getSourcesPaths,
  loadConfiguredSources,
  loadSources
} from "../src/config.js";
import { parseCommaSeparatedPaths, resolveMonitorPaths } from "../src/paths.js";

let tempDir: string;

function source(key: string, group: string, label = key) {
  return {
    key,
    type: "rss",
    label,
    rssUrl: `https://example.com/${key}.xml`,
    webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
    enabled: true,
    group
  };
}

describe("config", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "triple-monitor-config-"));
  });

  afterEach(async () => {
    delete process.env.MONITOR_SOURCES_PATH;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("MONITOR_SOURCES_PATH をカンマ区切りで解釈する", () => {
    expect(parseCommaSeparatedPaths(" a.json, ,b.json ", "fallback.json")).toEqual([
      "a.json",
      "b.json"
    ]);
    expect(parseCommaSeparatedPaths(undefined, "fallback.json")).toEqual(["fallback.json"]);
  });

  it("複数 sources ファイルをマージし、重複 key は後続ファイルを採用する", async () => {
    const firstPath = path.join(tempDir, "first.json");
    const secondPath = path.join(tempDir, "second.json");
    await writeFile(firstPath, JSON.stringify([source("shared", "old"), source("first", "one")]));
    await writeFile(
      secondPath,
      JSON.stringify([source("shared", "new", "Shared New"), source("second", "two")])
    );
    process.env.MONITOR_SOURCES_PATH = `${firstPath},${secondPath}`;

    await expect(loadConfiguredSources()).resolves.toMatchObject([
      { key: "shared", group: "new", label: "Shared New" },
      { key: "first", group: "one" },
      { key: "second", group: "two" }
    ]);
    await expect(loadSources("rss", "new")).resolves.toMatchObject([{ key: "shared" }]);
  });

  it("存在しない sources ファイルは空配列として扱う", async () => {
    process.env.MONITOR_SOURCES_PATH = path.join(tempDir, "missing.json");

    await expect(loadSources()).resolves.toEqual([]);
  });

  it("config 外の相対パスを拒否する", () => {
    expect(() => resolveMonitorPaths("../sources.json", "config")).toThrow("config path");
  });

  it("既定の sources path は default 用ファイルを指す", () => {
    delete process.env.MONITOR_SOURCES_PATH;

    expect(getSourcesPaths()).toEqual([path.resolve("config", "default-sources.json")]);
    expect(getSourcesPath()).toBe(path.resolve("config", "default-sources.json"));
  });
});
