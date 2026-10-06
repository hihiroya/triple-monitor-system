import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "./logger.js";
import { validateState } from "./state.js";
import { asErrorMessage } from "./utils.js";

const BRANCH = "refs/heads/monitor-state";
const TRACKING = "refs/remotes/origin/monitor-state";
const STATE_PATHS = ["state/default-state.json", "state/tourism-state.json"] as const;

function git(cwd: string, args: string[], input?: string, env = process.env): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function requireStatePath(statePath: string): void {
  if (!STATE_PATHS.some((allowed) => allowed === statePath)) {
    throw new Error(`Unsupported monitor state path: ${statePath}`);
  }
}

function fetchState(cwd: string): string {
  // Missing branch or network/auth failure is fatal: never fall back to main or empty state.
  git(cwd, ["fetch", "--no-tags", "origin", `+${BRANCH}:${TRACKING}`]);
  return git(cwd, ["rev-parse", TRACKING]).trim();
}

function readState(cwd: string, commit: string, statePath: string): { blob: string; body: string } {
  const entry = git(cwd, ["ls-tree", commit, "--", statePath]);
  const match = /^100644 blob ([a-f0-9]{40})\t/.exec(entry);
  if (!match?.[1]) throw new Error(`Required regular state file missing: ${statePath}`);
  const body = git(cwd, ["cat-file", "blob", match[1]]);
  validateState(JSON.parse(body) as unknown);
  return { blob: match[1], body };
}

async function makeCommit(
  cwd: string,
  files: { statePath: string; blob: string }[],
  message: string,
  parent?: string
): Promise<string> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "monitor-state-index-"));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(temporary, "index"),
    GIT_AUTHOR_NAME: "github-actions[bot]",
    GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com"
  };
  try {
    git(cwd, ["read-tree", ...(parent ? [parent] : ["--empty"])], undefined, env);
    for (const file of files) {
      git(
        cwd,
        ["update-index", "--add", "--cacheinfo", "100644", file.blob, file.statePath],
        undefined,
        env
      );
    }
    const tree = git(cwd, ["write-tree"], undefined, env).trim();
    return git(
      cwd,
      ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
      `${message}\n`,
      env
    ).trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Only copy state JSON; never checkout or execute anything from the state branch. */
export async function loadBranchState(statePath: string, cwd = process.cwd()): Promise<string> {
  requireStatePath(statePath);
  const commit = fetchState(cwd);
  const state = readState(cwd, commit, statePath);
  await writeFile(path.join(cwd, statePath), state.body, "utf8");
  await writeFile(path.join(cwd, ".monitor-state-baseline.json"), state.body, "utf8");
  await writeFile(
    path.join(cwd, ".monitor-state-recovery.json"),
    `${JSON.stringify(
      {
        branch: BRANCH,
        statePath,
        stateCommit: commit,
        baseBlob: state.blob,
        codeCommit: git(cwd, ["rev-parse", "HEAD"]).trim()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return state.blob;
}

/** Build a commit on the latest state tree, changing exactly one file; push only fast-forward. */
export async function saveBranchState(
  statePath: string,
  baseBlob: string,
  message: string,
  cwd = process.cwd()
): Promise<string> {
  requireStatePath(statePath);
  if (!/^[a-f0-9]{40}$/.test(baseBlob)) throw new Error("Missing loaded state baseline");
  const body = await readFile(path.join(cwd, statePath), "utf8");
  validateState(JSON.parse(body) as unknown);
  const desired = git(cwd, ["hash-object", "-w", "--stdin"], body).trim();
  if (desired === baseBlob) return "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const parent = fetchState(cwd);
    const current = readState(cwd, parent, statePath);
    // A previous push may have succeeded even if its network response was lost.
    if (current.blob === desired) return parent;
    if (current.blob !== baseBlob) {
      throw new Error(`Concurrent update to ${statePath}; refusing to overwrite notified state`);
    }
    const commit = await makeCommit(cwd, [{ statePath, blob: desired }], message, parent);
    try {
      git(cwd, ["push", "origin", `${commit}:${BRANCH}`]);
      return commit;
    } catch {
      // Refetch and rebuild, preserving updates to other paths. Never force-push or re-run notifications.
    }
  }
  // One final read recognizes a push that succeeded despite a lost response.
  const final = fetchState(cwd);
  if (readState(cwd, final, statePath).blob === desired) return final;
  throw new Error(
    "State push failed after 3 attempts; recover the saved artifact before resuming monitors"
  );
}

/** Explicit migration only, after all old monitor runs have been stopped and drained. */
export async function initializeStateBranch(cwd = process.cwd()): Promise<string> {
  if (git(cwd, ["ls-remote", "--heads", "origin", BRANCH]).trim()) {
    throw new Error("monitor-state already exists; initialization never overwrites it");
  }
  git(cwd, ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const main = git(cwd, ["rev-parse", "refs/remotes/origin/main"]).trim();
  const files = STATE_PATHS.map((statePath) => ({
    statePath,
    blob: readState(cwd, main, statePath).blob
  }));
  const commit = await makeCommit(cwd, files, `Initialize monitor state from main ${main}`);
  const latest = git(cwd, ["ls-remote", "--heads", "origin", "refs/heads/main"]).split(/\s/)[0];
  if (latest !== main)
    throw new Error("main moved during initialization; retry after monitors are drained");
  // A root commit cannot fast-forward an independently created branch: creation races fail safely.
  git(cwd, ["push", "origin", `${commit}:${BRANCH}`]);
  return commit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    const [command, statePath = "state/default-state.json"] = process.argv.slice(2);
    if (command === "load") {
      const baseBlob = await loadBranchState(statePath);
      if (!process.env.GITHUB_OUTPUT)
        throw new Error("GITHUB_OUTPUT is required for state provenance");
      await writeFile(process.env.GITHUB_OUTPUT, `base-blob=${baseBlob}\n`, { flag: "a" });
    } else if (command === "save") {
      await saveBranchState(
        statePath,
        process.env.MONITOR_STATE_BASE_BLOB || "",
        process.env.MONITOR_STATE_COMMIT_MESSAGE || "Update monitor state"
      );
    } else if (command === "initialize" && process.env.MONITORS_PAUSED === "true") {
      await initializeStateBranch();
    } else {
      throw new Error("Expected load/save, or initialize with MONITORS_PAUSED=true");
    }
  })().catch((error: unknown) => {
    logger.error(`Monitor state branch operation failed: ${asErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
