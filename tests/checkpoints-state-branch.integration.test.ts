import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDiscord } from "../src/discord.js";
import { fetchRssSnapshot } from "../src/rss.js";
import { runMain } from "../src/main.js";
import { initializeStateBranch, loadBranchState } from "../src/monitor-state-branch.js";
import type { MonitorState, RssSource } from "../src/types.js";

const sources = vi.hoisted(() => [] as RssSource[]);
vi.mock("../src/config.js", () => ({ loadSources: vi.fn(() => Promise.resolve(sources)) }));
vi.mock("../src/discord.js", () => ({ notifyDiscord: vi.fn() }));
vi.mock("../src/rss.js", () => ({ fetchRssSnapshot: vi.fn() }));
let temporary: string;
let remote: string;
let cwd: string;
let baseline: string;
let mainSha: string;
const statePath = "state/tourism-state.json";
const source: RssSource = {
  key: "test",
  type: "rss",
  label: "test",
  enabled: true,
  rssUrl: "https://example.invalid/feed",
  webhookEnvName: "TEST_WEBHOOK"
};
const initial = { sources: { test: { lastSeenItemId: "old", seenItemIds: ["old"] } } };
function git(at: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: at,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_EMAIL: "test@example.invalid"
    }
  }).trim();
}
function persist() {
  return spawnSync(
    process.execPath,
    [path.resolve("dist/monitor-state-branch.js"), "save", statePath],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        MONITOR_STATE_BASE_BLOB: baseline,
        MONITOR_STATE_COMMIT_MESSAGE: "Save integration checkpoint"
      }
    }
  );
}

describe("#50 + checkpoint integration (temporary branch only)", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    process.exitCode = undefined;
    temporary = await mkdtemp(path.join(os.tmpdir(), "monitor-integration-"));
    remote = path.join(temporary, "remote.git");
    cwd = path.join(temporary, "run");
    git(temporary, "init", "--bare", "--initial-branch=main", remote);
    git(temporary, "clone", remote, cwd);
    await mkdir(path.join(cwd, "state"));
    for (const name of ["default", "tourism"])
      await writeFile(
        path.join(cwd, `state/${name}-state.json`),
        `${JSON.stringify(initial, null, 2)}\n`
      );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "fixture");
    git(cwd, "push", "origin", "main");
    mainSha = git(remote, "rev-parse", "main");
    await initializeStateBranch(cwd);
    baseline = await loadBranchState(statePath, cwd);
    vi.stubEnv("MONITOR_STATE_PATH", path.join(cwd, statePath));
    vi.stubEnv("MONITOR_REQUIRE_STATE", "true");
    sources.splice(0, sources.length, source);
    vi.mocked(fetchRssSnapshot).mockResolvedValue({
      kind: "list",
      items: ["new2", "new1", "old"].map((id) => ({ id, title: id }))
    });
  });
  afterEach(async () => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    await rm(temporary, { recursive: true, force: true });
  });
  async function partialSuccess(): Promise<void> {
    vi.mocked(notifyDiscord)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        expect(JSON.parse(await readFile(path.join(cwd, statePath), "utf8"))).toEqual({
          sources: { test: { lastSeenItemId: "new1", seenItemIds: ["new1", "old"] } }
        });
        throw new Error("later notification failed");
      });
    await runMain([]);
    expect(process.exitCode).toBe(1);
  }
  it("preserves each checkpoint and saves only successes to monitor-state after later notification failure", async () => {
    await partialSuccess();
    const result = persist();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(git(remote, "show", `monitor-state:${statePath}`))).toEqual({
      sources: { test: { lastSeenItemId: "new1", seenItemIds: ["new1", "old"] } }
    });
    expect(git(remote, "rev-parse", "main")).toBe(mainSha);
    expect(git(remote, "show", "monitor-state:state/default-state.json")).toBe(
      JSON.stringify(initial, null, 2)
    );
  });
  it("stops subsequent notification and source on a real local rename failure", async () => {
    sources.push({ ...source, key: "second-source" });
    vi.mocked(notifyDiscord).mockImplementationOnce(async () => {
      // A directory at the target makes atomic replacement fail on Windows and Linux.
      await rm(path.join(cwd, statePath));
      await mkdir(path.join(cwd, statePath));
    });
    await expect(runMain([])).rejects.toThrow("通知成功後の状態保存に失敗");
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(fetchRssSnapshot).toHaveBeenCalledTimes(1);
    expect(git(remote, "rev-parse", "main")).toBe(mainSha);
  });
  it("retains successful state and exact provenance in all configured recovery artifact paths after push failure", async () => {
    await partialSuccess();
    const hook = path.join(remote, "hooks/pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const before = git(remote, "rev-parse", "monitor-state");
    const result = persist();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("State push failed after 3 attempts");
    expect(git(remote, "rev-parse", "monitor-state")).toBe(before);
    const action = await readFile(".github/actions/commit-monitor-state/action.yml", "utf8");
    expect(action).toContain("if: failure() && steps.persist.outcome == 'failure'");
    expect(action).toContain("include-hidden-files: true");
    expect(action).toContain("if-no-files-found: error");
    expect(action).toContain("retention-days: 30");
    const block = / {8}path: \|\r?\n([\s\S]*?) {8}include-hidden-files:/.exec(action)?.[1];
    expect(block).toBeDefined();
    const paths = block!
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().replace("${{ inputs.state-path }}", statePath));
    expect(paths).toEqual([
      statePath,
      ".monitor-state-baseline.json",
      ".monitor-state-recovery.json"
    ]);
    // Capture exactly the upload inputs locally; no GitHub upload/event is executed.
    const artifact = path.join(temporary, "captured-artifact");
    await mkdir(artifact);
    for (const name of paths)
      await cp(path.join(cwd, name), path.join(artifact, path.basename(name)));
    const saved = JSON.parse(
      await readFile(path.join(artifact, "tourism-state.json"), "utf8")
    ) as MonitorState;
    expect(saved.sources.test?.seenItemIds).toEqual(["new1", "old"]);
    expect(
      JSON.parse(await readFile(path.join(artifact, ".monitor-state-baseline.json"), "utf8"))
    ).toEqual(initial);
    expect(
      JSON.parse(await readFile(path.join(artifact, ".monitor-state-recovery.json"), "utf8"))
    ).toEqual({
      branch: "refs/heads/monitor-state",
      statePath,
      stateCommit: before,
      baseBlob: baseline,
      codeCommit: mainSha
    });
  });
});
