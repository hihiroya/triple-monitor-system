import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initializeStateBranch,
  loadBranchState,
  saveBranchState
} from "../src/monitor-state-branch.js";

const DEFAULT = "state/default-state.json";
const TOURISM = "state/tourism-state.json";
let temporary: string;
let remote: string;
let first: string;
let second: string;
const state = (id: string): string =>
  `${JSON.stringify({ sources: { test: { seenItemIds: [id], lastSeenItemId: id } } }, null, 2)}\n`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  }).trim();
}
async function commitState(cwd: string, file: string, value: string): Promise<void> {
  await writeFile(path.join(cwd, file), value, "utf8");
  git(cwd, "add", file);
  git(cwd, "commit", "-m", "Update fixture state");
}
async function initialize(): Promise<void> {
  await initializeStateBranch(first);
}

describe("monitor state branch persistence with real Git remotes", () => {
  beforeEach(async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "monitor-state-git-"));
    remote = path.join(temporary, "remote.git");
    first = path.join(temporary, "first");
    second = path.join(temporary, "second");
    git(temporary, "init", "--bare", "--initial-branch=main", remote);
    git(temporary, "clone", remote, first);
    await mkdir(path.join(first, "state"));
    await writeFile(path.join(first, DEFAULT), state("original"));
    await writeFile(path.join(first, TOURISM), state("tourism-original"));
    await writeFile(path.join(first, "code.txt"), "main code\n");
    git(first, "add", ".");
    git(first, "commit", "-m", "Initialize main fixture");
    git(first, "push", "origin", "main");
    git(temporary, "clone", remote, second);
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it("initializes from latest main, not the stale checkout, with state-only orphan history", async () => {
    await commitState(second, DEFAULT, state("latest-at-migration"));
    git(second, "push", "origin", "main");
    const main = git(remote, "rev-parse", "main");
    const commit = await initializeStateBranch(first);
    expect(git(remote, "show", `monitor-state:${DEFAULT}`)).toBe(
      state("latest-at-migration").trim()
    );
    expect(git(remote, "ls-tree", "-r", "--name-only", commit).split("\n")).toEqual([
      DEFAULT,
      TOURISM
    ]);
    expect(git(remote, "rev-list", "--count", "monitor-state")).toBe("1");
    expect(git(remote, "rev-parse", "main")).toBe(main);
    expect(git(first, "branch", "--show-current")).toBe("main");
    await expect(initializeStateBranch(first)).rejects.toThrow("already exists");
  });

  it("fails a missing or unreachable state branch and preserves the main snapshot", async () => {
    await expect(loadBranchState(DEFAULT, first)).rejects.toThrow();
    expect(await readFile(path.join(first, DEFAULT), "utf8")).toBe(state("original"));
    git(first, "remote", "set-url", "origin", path.join(temporary, "absent.git"));
    await expect(loadBranchState(DEFAULT, first)).rejects.toThrow();
  });

  it("loads branch JSON without changing code, HEAD or the main Git index", async () => {
    await initialize();
    const before = git(first, "rev-parse", "HEAD");
    const index = git(first, "write-tree");
    const base = await loadBranchState(DEFAULT, first);
    expect(base).toMatch(/^[a-f0-9]{40}$/);
    expect(git(first, "rev-parse", "HEAD")).toBe(before);
    expect(git(first, "write-tree")).toBe(index);
    expect(await readFile(path.join(first, "code.txt"), "utf8")).toBe("main code\n");
    expect(
      JSON.parse(
        await readFile(path.join(first, ".monitor-state-recovery.json"), "utf8")
      ) as unknown
    ).toMatchObject({ statePath: DEFAULT, baseBlob: base });
    expect(await readFile(path.join(first, ".monitor-state-baseline.json"), "utf8")).toBe(
      state("original")
    );
  });

  it("saves both disjoint workflow updates and never pushes main or unrelated local files", async () => {
    await initialize();
    const main = git(remote, "rev-parse", "main");
    const a = await loadBranchState(DEFAULT, first);
    const b = await loadBranchState(TOURISM, second);
    await writeFile(path.join(first, DEFAULT), state("default-new"));
    await writeFile(path.join(first, "code.txt"), "unrelated dirty code\n");
    await saveBranchState(DEFAULT, a, "default update", first);
    await writeFile(path.join(second, TOURISM), state("tourism-new"));
    const saved = await saveBranchState(TOURISM, b, "tourism update", second);
    expect(git(remote, "show", `monitor-state:${DEFAULT}`)).toBe(state("default-new").trim());
    expect(git(remote, "show", `monitor-state:${TOURISM}`)).toBe(state("tourism-new").trim());
    expect(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", saved)).toBe(TOURISM);
    expect(git(remote, "rev-parse", "main")).toBe(main);
    expect(git(remote, "ls-tree", "-r", "--name-only", "monitor-state")).not.toContain("code.txt");
  });

  it("refuses same-file races while keeping notification state and recovery provenance locally", async () => {
    await initialize();
    const a = await loadBranchState(DEFAULT, first);
    const b = await loadBranchState(DEFAULT, second);
    await writeFile(path.join(first, DEFAULT), state("first-notified"));
    await saveBranchState(DEFAULT, a, "first", first);
    await writeFile(path.join(second, DEFAULT), state("second-notified"));
    await expect(saveBranchState(DEFAULT, b, "second", second)).rejects.toThrow(
      "Concurrent update"
    );
    expect(git(remote, "show", `monitor-state:${DEFAULT}`)).toBe(state("first-notified").trim());
    expect(await readFile(path.join(second, DEFAULT), "utf8")).toBe(state("second-notified"));
    expect(await readFile(path.join(second, ".monitor-state-baseline.json"), "utf8")).toBe(
      state("original")
    );
  });

  it("treats unchanged and already-persisted JSON as no-op/idempotent", async () => {
    await initialize();
    const a = await loadBranchState(DEFAULT, first);
    const before = git(remote, "rev-parse", "monitor-state");
    expect(await saveBranchState(DEFAULT, a, "unchanged", first)).toBe("");
    expect(git(remote, "rev-parse", "monitor-state")).toBe(before);
    await writeFile(path.join(first, DEFAULT), state("notified"));
    const saved = await saveBranchState(DEFAULT, a, "save", first);
    expect(await saveBranchState(DEFAULT, a, "retry lost push response", first)).toBe(saved);
  });

  it("retries rejected pushes a bounded number of times without losing the local state", async () => {
    await initialize();
    const a = await loadBranchState(DEFAULT, first);
    const before = git(remote, "rev-parse", "monitor-state");
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho rejected >> attempts.txt\nexit 1\n", "utf8");
    await chmod(hook, 0o755);
    await writeFile(path.join(first, DEFAULT), state("notified-but-unsaved"));
    await expect(saveBranchState(DEFAULT, a, "failed", first)).rejects.toThrow("3 attempts");
    expect(
      (await readFile(path.join(remote, "attempts.txt"), "utf8")).trim().split("\n")
    ).toHaveLength(3);
    expect(git(remote, "rev-parse", "monitor-state")).toBe(before);
    expect(await readFile(path.join(first, DEFAULT), "utf8")).toBe(state("notified-but-unsaved"));
  });

  it("rebuilds on a concurrent other-file push between fetch and push", async () => {
    await initialize();
    const base = await loadBranchState(DEFAULT, first);
    git(second, "fetch", "origin", "monitor-state");
    git(second, "checkout", "-b", "race", "FETCH_HEAD");
    await commitState(second, TOURISM, state("concurrent-tourism"));
    git(second, "push", "origin", "HEAD:race-candidate");
    const concurrent = git(second, "rev-parse", "HEAD");
    const shellPath = `'${remote.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
    const hook = path.join(first, ".git", "hooks", "pre-push");
    await writeFile(
      hook,
      `#!/bin/sh\nif [ ! -f .git/raced ]; then\n touch .git/raced\n git --git-dir=${shellPath} update-ref refs/heads/monitor-state ${concurrent}\nfi\n`,
      "utf8"
    );
    await chmod(hook, 0o755);
    await writeFile(path.join(first, DEFAULT), state("default-notified"));
    await saveBranchState(DEFAULT, base, "retry with latest tree", first);
    expect(git(remote, "show", `monitor-state:${DEFAULT}`)).toBe(state("default-notified").trim());
    expect(git(remote, "show", `monitor-state:${TOURISM}`)).toBe(
      state("concurrent-tourism").trim()
    );
  });

  it("runs the compiled load/save CLI used by the composite actions", async () => {
    await initialize();
    const output = path.join(temporary, "output");
    const cli = path.resolve("dist/monitor-state-branch.js");
    const env = { ...process.env, GITHUB_OUTPUT: output };
    execFileSync(process.execPath, [cli, "load", DEFAULT], { cwd: first, env });
    const base = (await readFile(output, "utf8")).trim().replace("base-blob=", "");
    expect(base).toMatch(/^[a-f0-9]{40}$/);
    await writeFile(path.join(first, DEFAULT), state("cli-notified"));
    execFileSync(process.execPath, [cli, "save", DEFAULT], {
      cwd: first,
      env: { ...env, MONITOR_STATE_BASE_BLOB: base }
    });
    expect(git(remote, "show", `monitor-state:${DEFAULT}`)).toBe(state("cli-notified").trim());
    expect(() =>
      execFileSync(process.execPath, [cli, "initialize"], {
        cwd: first,
        env: { ...env, MONITORS_PAUSED: "false" },
        stdio: "pipe"
      })
    ).toThrow();
  });

  it("rejects corrupt runtime JSON and missing files instead of falling back", async () => {
    await initialize();
    git(second, "fetch", "origin", "monitor-state");
    git(second, "checkout", "-b", "state-fixture", "FETCH_HEAD");
    await commitState(second, DEFAULT, "{broken\n");
    git(second, "push", "origin", "HEAD:monitor-state");
    await expect(loadBranchState(DEFAULT, first)).rejects.toThrow();
    git(second, "rm", TOURISM);
    git(second, "commit", "-m", "Delete required fixture state");
    git(second, "push", "origin", "HEAD:monitor-state");
    await expect(loadBranchState(TOURISM, first)).rejects.toThrow("missing");
  });

  it("refuses invalid initialization snapshots and unsupported paths or absent baselines", async () => {
    await commitState(second, DEFAULT, "{broken\n");
    git(second, "push", "origin", "main");
    await expect(initializeStateBranch(first)).rejects.toThrow();
    expect(git(remote, "ls-remote", "--heads", remote, "monitor-state")).toBe("");
    await expect(loadBranchState("../outside.json", first)).rejects.toThrow("Unsupported");
    await expect(saveBranchState(DEFAULT, "", "no baseline", first)).rejects.toThrow("baseline");
  });
});
