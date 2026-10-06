import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise the exact privileged script shipped in the workflow, without network or writes.
const workflow = readFileSync(
  new URL("../.github/workflows/dependabot-auto-merge.yml", import.meta.url),
  "utf8"
);
const script = workflow
  .split("          script: |\n")[1]
  ?.split("\n      - name: Enable squash")[0]
  ?.split("\n")
  .map((line) => line.slice(12))
  .join("\n");
if (!script) throw new Error("Workflow eligibility script missing");

function fixture() {
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    scripts: { test: "vitest run" },
    dependencies: { production: "^2.0.0" },
    devDependencies: { vitest: "^4.1.8" }
  };
  const oldLock = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": structuredClone(manifest),
      "node_modules/vitest": {
        version: "4.1.8",
        dev: true,
        resolved: "https://registry.npmjs.org/vitest/-/vitest-4.1.8.tgz",
        integrity: "sha512-old"
      },
      "node_modules/production": {
        version: "2.0.0",
        dev: false,
        resolved: "https://registry.npmjs.org/production/-/production-2.0.0.tgz",
        integrity: "sha512-prod"
      }
    }
  };
  const newManifest = structuredClone(manifest);
  newManifest.devDependencies.vitest = "^4.1.11";
  const newLock = structuredClone(oldLock);
  newLock.packages[""].devDependencies.vitest = "^4.1.11";
  newLock.packages["node_modules/vitest"].version = "4.1.11";
  newLock.packages["node_modules/vitest"].resolved =
    "https://registry.npmjs.org/vitest/-/vitest-4.1.11.tgz";
  newLock.packages["node_modules/vitest"].integrity = "sha512-new";
  return {
    manifest,
    newManifest,
    oldLock,
    newLock,
    pr: {
      number: 99,
      state: "open",
      draft: false,
      changed_files: 2,
      user: { login: "dependabot[bot]" },
      head: { sha: "head", repo: { full_name: "hihiroya/triple-monitor-system" } },
      base: { sha: "base", ref: "main", repo: { full_name: "hihiroya/triple-monitor-system" } }
    },
    updates: [
      {
        dependencyName: "vitest",
        dependencyType: "direct:development",
        updateType: "version-update:semver-patch",
        packageEcosystem: "npm_and_yarn",
        directory: "/",
        targetBranch: "main",
        maintainerChanges: false
      }
    ],
    files: [
      { filename: "package.json", status: "modified" },
      { filename: "package-lock.json", status: "modified" }
    ],
    settings: { allow_auto_merge: true, allow_squash_merge: true },
    ruleset: {
      enforcement: "active",
      bypass_actors: [] as { actor_type: string; actor_id: number }[]
    },
    rules: [
      {
        type: "required_status_checks",
        ruleset_id: 1,
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "quality", integration_id: 15368 }]
        }
      }
    ],
    classic: null as null | {
      requiresStatusChecks: boolean;
      requiresStrictStatusChecks: boolean;
      isAdminEnforced: boolean;
      requiredStatusChecks: { context: string; app: { databaseId: number } }[];
    },
    checks: [
      { id: 1, name: "quality", app: { id: 15368 }, status: "completed", conclusion: "success" }
    ],
    eventHead: "head",
    unavailable: false
  };
}

type Fixture = ReturnType<typeof fixture>;
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected a fixture element");
  return value;
}
async function eligible(data: Fixture): Promise<boolean> {
  const github = {
    request: (route: string, params: { path?: string; ref?: string }) => {
      if (data.unavailable) throw new Error("API unavailable");
      let result: unknown;
      if (route.endsWith("/pulls/{pull_number}")) result = data.pr;
      else if (route.endsWith("/compare/{basehead}"))
        result = { merge_base_commit: { sha: "base" } };
      else if (route.endsWith("/contents/{path}")) {
        const base = params.ref === "base";
        const value =
          params.path === "package.json"
            ? base
              ? data.manifest
              : data.newManifest
            : base
              ? data.oldLock
              : data.newLock;
        result = {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(value)).toString("base64")
        };
      } else if (route.endsWith("/rules/branches/{branch}")) result = data.rules;
      else if (route.endsWith("/rulesets/{ruleset_id}")) result = data.ruleset;
      else if (route === "GET /repos/{owner}/{repo}") result = data.settings;
      else throw new Error(`Unexpected request: ${route}`);
      return Promise.resolve({ data: result });
    },
    paginate: (route: string) =>
      Promise.resolve(route.endsWith("/files") ? data.files : data.checks),
    graphql: () => Promise.resolve({ repository: { ref: { branchProtectionRule: data.classic } } })
  };
  const policy = new Script(`(async () => {\n${script}\n})()`);
  const result: unknown = policy.runInNewContext({
    github,
    Buffer,
    core: { info: () => undefined, warning: () => undefined },
    context: {
      repo: { owner: "hihiroya", repo: "triple-monitor-system" },
      payload: { pull_request: { number: 99, head: { sha: data.eventHead } } }
    },
    process: { env: { DEPENDABOT_UPDATES: JSON.stringify(data.updates) } }
  });
  return await (result as Promise<boolean>);
}

describe("Dependabot auto-merge eligibility", () => {
  it("accepts a verified development patch with strict app-scoped rules", async () => {
    expect(await eligible(fixture())).toBe(true);
  });
  it("accepts strict classic branch protection", async () => {
    const data = fixture();
    data.rules = [];
    data.classic = {
      requiresStatusChecks: true,
      requiresStrictStatusChecks: true,
      isAdminEnforced: true,
      requiredStatusChecks: [{ context: "quality", app: { databaseId: 15368 } }]
    };
    expect(await eligible(data)).toBe(true);
  });
  it("accepts a stable development minor update", async () => {
    const data = fixture();
    data.newManifest.devDependencies.vitest = "^4.2.0";
    data.newLock.packages[""].devDependencies.vitest = "^4.2.0";
    data.newLock.packages["node_modules/vitest"].version = "4.2.0";
    first(data.updates).updateType = "version-update:semver-minor";
    expect(await eligible(data)).toBe(true);
  });
  it("rejects rulesets with bypass actors or inactive enforcement", async () => {
    const data = fixture();
    data.ruleset.bypass_actors.push({ actor_type: "Integration", actor_id: 15368 });
    expect(await eligible(data)).toBe(false);
    data.ruleset.bypass_actors = [];
    data.ruleset.enforcement = "evaluate";
    expect(await eligible(data)).toBe(false);
  });
  it("rejects classic protection that exempts administrators", async () => {
    const data = fixture();
    data.rules = [];
    data.classic = {
      requiresStatusChecks: true,
      requiresStrictStatusChecks: true,
      isAdminEnforced: false,
      requiredStatusChecks: [{ context: "quality", app: { databaseId: 15368 } }]
    };
    expect(await eligible(data)).toBe(false);
  });
  it("can queue pending CI, which GitHub protection must keep unmerged", async () => {
    const data = fixture();
    first(data.checks).status = "in_progress";
    first(data.checks).conclusion = "";
    expect(await eligible(data)).toBe(true);
  });
  const exclusions: [string, (data: Fixture) => void][] = [
    [
      "normal PR",
      (d) => {
        d.pr.user.login = "hihiroya";
      }
    ],
    [
      "fork PR",
      (d) => {
        d.pr.head.repo.full_name = "other/triple-monitor-system";
      }
    ],
    [
      "different base",
      (d) => {
        d.pr.base.ref = "develop";
      }
    ],
    [
      "draft PR",
      (d) => {
        d.pr.draft = true;
      }
    ],
    [
      "stale event SHA",
      (d) => {
        d.eventHead = "stale";
      }
    ],
    [
      "major in a mixed group",
      (d) => {
        d.updates.push({
          ...first(d.updates),
          dependencyName: "knip",
          updateType: "version-update:semver-major"
        });
      }
    ],
    [
      "production in a mixed group",
      (d) => {
        d.updates.push({
          ...first(d.updates),
          dependencyName: "production",
          dependencyType: "direct:production"
        });
      }
    ],
    [
      "GitHub Actions",
      (d) => {
        first(d.updates).packageEcosystem = "github_actions";
      }
    ],
    [
      "empty metadata",
      (d) => {
        d.updates = [];
      }
    ],
    [
      "unknown update type",
      (d) => {
        first(d.updates).updateType = "";
      }
    ],
    [
      "extra changed file",
      (d) => {
        d.pr.changed_files++;
        d.files.push({ filename: ".npmrc", status: "modified" });
      }
    ],
    [
      "renamed manifest",
      (d) => {
        first(d.files).status = "renamed";
      }
    ],
    [
      "incomplete file listing",
      (d) => {
        d.pr.changed_files++;
      }
    ],
    [
      "changed npm script",
      (d) => {
        d.newManifest.scripts.test = "echo replaced";
      }
    ],
    [
      "production manifest update",
      (d) => {
        d.newManifest.dependencies.production = "^2.0.1";
      }
    ],
    [
      "production transitive update",
      (d) => {
        d.newLock.packages["node_modules/production"].version = "2.0.1";
      }
    ],
    [
      "shared dependency",
      (d) => {
        d.oldLock.packages["node_modules/vitest"].dev = false;
      }
    ],
    [
      "hidden major in lockfile",
      (d) => {
        d.newLock.packages["node_modules/vitest"].version = "5.0.0";
      }
    ],
    [
      "prerelease",
      (d) => {
        d.newLock.packages["node_modules/vitest"].version = "4.2.0-beta.1";
      }
    ],
    [
      "downgrade",
      (d) => {
        d.newLock.packages["node_modules/vitest"].version = "4.1.7";
      }
    ],
    [
      "remote tarball",
      (d) => {
        d.newLock.packages["node_modules/vitest"].resolved = "https://example.com/vitest.tgz";
      }
    ],
    [
      "missing integrity",
      (d) => {
        d.newLock.packages["node_modules/vitest"].integrity = "";
      }
    ],
    [
      "unmatched metadata",
      (d) => {
        first(d.updates).dependencyName = "knip";
      }
    ],
    [
      "disabled auto-merge",
      (d) => {
        d.settings.allow_auto_merge = false;
      }
    ],
    [
      "missing protection",
      (d) => {
        d.rules = [];
      }
    ],
    [
      "non-strict protection",
      (d) => {
        first(d.rules).parameters.strict_required_status_checks_policy = false;
      }
    ],
    [
      "wrong required check name",
      (d) => {
        first(first(d.rules).parameters.required_status_checks).context = "Quality Check";
      }
    ],
    [
      "wrong required check app",
      (d) => {
        first(first(d.rules).parameters.required_status_checks).integration_id = 1;
      }
    ],
    [
      "failed CI",
      (d) => {
        first(d.checks).conclusion = "failure";
      }
    ],
    [
      "cancelled CI",
      (d) => {
        first(d.checks).conclusion = "cancelled";
      }
    ],
    [
      "skipped CI",
      (d) => {
        first(d.checks).conclusion = "skipped";
      }
    ],
    [
      "API error",
      (d) => {
        d.unavailable = true;
      }
    ]
  ];
  it.each(exclusions)("rejects %s", async (_, mutate) => {
    const data = fixture();
    mutate(data);
    expect(await eligible(data)).toBe(false);
  });
  it("uses the newest CI attempt", async () => {
    const data = fixture();
    data.checks.push({ ...first(data.checks), id: 2, conclusion: "failure" });
    expect(await eligible(data)).toBe(false);
  });
  it("never checks out PR code or uses an admin bypass", () => {
    expect(workflow).not.toMatch(/uses:.*checkout|--admin|^\s*run:.*npm (?:ci|install)/m);
    expect(workflow).toContain('--auto --squash --match-head-commit "$PR_HEAD_SHA"');
    const actions = [...workflow.matchAll(/uses: [^@\s]+@(\S+)/g)];
    expect(actions).toHaveLength(2);
    for (const action of actions) expect(action[1]).toMatch(/^[a-f0-9]{40}$/);
  });
});
