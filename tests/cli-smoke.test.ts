import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let tempDir: string;

describe("CLI smoke test", () => {
  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `triple-monitor-system-${process.pid}-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("build 済み CLI はテスト用 config/state で起動できる", async () => {
    const sourcesPath = path.join(tempDir, "sources.json");
    const statePath = path.join(tempDir, "monitor-state.json");
    await writeFile(
      sourcesPath,
      `${JSON.stringify(
        [
          {
            key: "disabled-rss",
            type: "rss",
            label: "Disabled RSS",
            rssUrl: "https://example.com/feed.xml",
            webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
            enabled: false
          }
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await execFileAsync("node", ["dist/main.js", "--type", "rss"], {
      env: {
        ...process.env,
        MONITOR_SOURCES_PATH: sourcesPath,
        MONITOR_STATE_PATH: statePath
      }
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("監視対象 source 数: 0 type=rss");
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
