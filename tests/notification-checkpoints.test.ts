import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDiscord } from "../src/discord.js";
import { fetchRssSnapshot } from "../src/rss.js";
import { runSource } from "../src/source-runner.js";
import { loadState, saveState } from "../src/state.js";
import type { MonitorState, RssSource } from "../src/types.js";

vi.mock("../src/discord.js", () => ({ notifyDiscord: vi.fn() }));
vi.mock("../src/notion.js", () => ({
  fetchNotionPageSnapshot: vi.fn(),
  fetchNotionDatabaseSnapshot: vi.fn()
}));
vi.mock("../src/rss.js", () => ({ fetchRssSnapshot: vi.fn() }));

const source: RssSource = {
  key: "checkpoint-test",
  type: "rss",
  label: "test",
  enabled: true,
  rssUrl: "https://example.invalid/feed",
  webhookEnvName: "TEST_WEBHOOK"
};
const initial = (): MonitorState => ({
  sources: {
    [source.key]: { lastSeenItemId: "old", seenItemIds: ["old"] }
  }
});
let tempDir: string;

describe("notification checkpoints", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notification-checkpoints-"));
    vi.stubEnv("MONITOR_STATE_PATH", path.join(tempDir, "state.json"));
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: ["new2", "new1", "old"].map((id) => ({ id, title: id }))
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });
  it("persists the first success before starting the next notification; failure stays unread", async () => {
    await saveState(initial());
    vi.mocked(notifyDiscord)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        const saved = await loadState();
        expect(saved.sources[source.key]?.seenItemIds).toEqual(["new1", "old"]);
        throw new Error("second notification failed");
      });
    const result = await runSource(source, initial(), saveState);
    expect(result.ok).toBe(false);
    expect((await loadState()).sources[source.key]?.lastSeenItemId).toBe("new1");
    expect((await loadState()).sources[source.key]?.seenItemIds).not.toContain("new2");
  });
  it("stops further notifications when checkpoint saving fails, retaining the previous file", async () => {
    await saveState(initial());
    vi.mocked(notifyDiscord).mockResolvedValue(undefined);
    const checkpoint = vi.fn().mockRejectedValue(new Error("disk unavailable"));
    await expect(runSource(source, initial(), checkpoint)).rejects.toThrow(
      "通知成功後の状態保存に失敗"
    );
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(await loadState()).toEqual(initial());
  });
  it("retains the earlier checkpoint if saving a later successful notification fails", async () => {
    await saveState(initial());
    vi.mocked(notifyDiscord).mockResolvedValue(undefined);
    let saves = 0;
    const checkpoint = async (state: MonitorState): Promise<void> => {
      if (++saves === 2) throw new Error("disk unavailable");
      await saveState(state);
    };
    await expect(runSource(source, initial(), checkpoint)).rejects.toThrow(
      "通知成功後の状態保存に失敗"
    );
    expect((await loadState()).sources[source.key]?.seenItemIds).toEqual(["new1", "old"]);
    expect(notifyDiscord).toHaveBeenCalledTimes(2);
  });
  it("does not checkpoint an unsuccessful first notification", async () => {
    await saveState(initial());
    vi.mocked(notifyDiscord).mockRejectedValue(new Error("failed"));
    const checkpoint = vi.fn(saveState);
    expect((await runSource(source, initial(), checkpoint)).ok).toBe(false);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(await loadState()).toEqual(initial());
  });
  it("persists a successful version notification before returning", async () => {
    const { fetchNotionPageSnapshot } = await import("../src/notion.js");
    vi.mocked(fetchNotionPageSnapshot).mockResolvedValue({
      kind: "version",
      version: "new",
      title: "new"
    });
    vi.mocked(notifyDiscord).mockResolvedValue(undefined);
    const state: MonitorState = { sources: { version: { lastSeenVersion: "old" } } };
    await runSource(
      {
        key: "version",
        type: "notion_api_page_poll",
        label: "version",
        enabled: true,
        pageId: "page",
        notionTokenEnvName: "TOKEN",
        webhookEnvName: "WEBHOOK"
      },
      state,
      saveState
    );
    expect((await loadState()).sources.version?.lastSeenVersion).toBe("new");
  });
  it("recovers the first success after a real process kill during the second notification", async () => {
    await saveState(initial());
    const runnerUrl = pathToFileURL(path.resolve("dist/source-runner.js")).href;
    const stateUrl = pathToFileURL(path.resolve("dist/state.js")).href;
    const script = `
      import { runSource } from ${JSON.stringify(runnerUrl)};
      import { saveState } from ${JSON.stringify(stateUrl)};
      let posts = 0;
      globalThis.fetch = async (_url, init) => {
        if (init?.method === 'POST') {
          if (++posts === 1) return new Response(null, { status: 204 });
          process.stdout.write('SECOND_NOTIFICATION\\n');
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
        return new Response('<rss version="2.0"><channel>' +
          ['new2','new1','old'].map(id => '<item><guid>' + id + '</guid><title>' + id + '</title></item>').join('') +
          '</channel></rss>');
      };
      await runSource(${JSON.stringify(source)}, ${JSON.stringify(initial())}, saveState);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TEST_WEBHOOK: "https://example.invalid/webhook" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child stalled: ${stderr}`)), 5000);
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("SECOND_NOTIFICATION")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("close", () => {
          clearTimeout(timer);
          reject(new Error(`early exit: ${stderr}`));
        });
      });
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    const saved = JSON.parse(
      await readFile(path.join(tempDir, "state.json"), "utf8")
    ) as MonitorState;
    expect(saved.sources[source.key]?.lastSeenItemId).toBe("new1");
    expect(saved.sources[source.key]?.seenItemIds).toEqual(["new1", "old"]);
  });
});
