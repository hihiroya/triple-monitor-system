import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { extractRssHubToken, startRssHub } from "../src/rsshub.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("RSSHub credentials", () => {
  it.each([
    "test-token",
    " auth_token=test-token; ct0=csrf-secret ",
    "ct0=csrf-secret; auth_token = test-token;"
  ])("extracts only auth_token from %s", (value) => {
    expect(extractRssHubToken(value)).toBe("test-token");
  });

  it.each([
    undefined,
    "",
    "ct0=secret",
    "auth_token=; ct0=secret",
    "auth_token=a; auth_token=b",
    "bad\ntoken"
  ])("rejects invalid credentials without including them in the error", (value) => {
    expect(() => extractRssHubToken(value)).toThrow(
      "TWITTER_AUTH_TOKEN must be a token value or a Cookie header containing one non-empty auth_token."
    );
  });

  it("passes the extracted token only through Docker's environment and masks it", () => {
    vi.stubEnv("TWITTER_AUTH_TOKEN", "auth_token=test-token; ct0=csrf-secret");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const log = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    startRssHub();
    expect(log).toHaveBeenCalledWith("::add-mask::test-token\n");
    const [command, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(command).toBe("docker");
    expect(args).not.toContain("test-token");
    expect(options).toMatchObject({ env: { TWITTER_AUTH_TOKEN: "test-token" }, timeout: 120_000 });
    expect(process.env.TWITTER_AUTH_TOKEN).toBe("auth_token=test-token; ct0=csrf-secret");
  });

  it("fails if Docker cannot start", () => {
    vi.stubEnv("TWITTER_AUTH_TOKEN", "test-token");
    vi.stubEnv("GITHUB_ACTIONS", "false");
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(startRssHub).toThrow("RSSHub container startup failed.");
  });
});
