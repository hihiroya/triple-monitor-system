import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function extractRssHubToken(value: string = ""): string {
  const input = value.trim();
  const tokens = input
    .split(";")
    .map((part) => part.trim())
    .filter((part) => /^auth_token\s*=/.test(part));
  const token = tokens.length === 1 ? tokens[0]!.slice(tokens[0]!.indexOf("=") + 1).trim() : input;
  // Reject ambiguous cookies and control characters without logging credentials.
  if (tokens.length > 1 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(
      "TWITTER_AUTH_TOKEN must be a token value or a Cookie header containing one non-empty auth_token."
    );
  }
  return token;
}

export function startRssHub(): void {
  const token = extractRssHubToken(process.env.TWITTER_AUTH_TOKEN);
  if (process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`::add-mask::${token}\n`);
  }
  const result = spawnSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      "x-twitter-rsshub",
      "--publish",
      "127.0.0.1:1200:1200",
      "--env",
      "CACHE_TYPE=memory",
      "--env",
      "REQUEST_TIMEOUT=10000",
      "--env",
      "TWITTER_AUTH_TOKEN",
      "ghcr.io/diygod/rsshub:latest"
    ],
    {
      env: { ...process.env, TWITTER_AUTH_TOKEN: token },
      stdio: "inherit",
      timeout: 120_000
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error("RSSHub container startup failed.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startRssHub();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "RSSHub startup failed."}\n`);
    process.exitCode = 1;
  }
}
