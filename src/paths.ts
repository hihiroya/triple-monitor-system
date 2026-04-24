import os from "node:os";
import path from "node:path";

type MonitorPathKind = "config" | "state";

const DEFAULT_PATHS: Record<MonitorPathKind, string> = {
  config: path.join("config", "default-sources.json"),
  state: path.join("state", "default-state.json")
};

const REPOSITORY_ROOTS: Record<MonitorPathKind, string> = {
  config: path.resolve("config"),
  state: path.resolve("state")
};

function isPathInside(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * MONITOR_*_PATH はカンマ区切りで複数指定できる。空要素は無視し、未指定時は
 * kind ごとの標準ファイルを返す。
 */
export function parseCommaSeparatedPaths(
  value: string | undefined,
  fallbackPath: string
): string[] {
  const paths = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return paths && paths.length > 0 ? paths : [fallbackPath];
}

/**
 * リポジトリ内の config/state からの逸脱を防ぐ。テスト用の絶対パスだけは OS の
 * 一時ディレクトリ配下を許可し、CLI smoke test の独立性を保つ。
 */
export function resolveMonitorPaths(value: string | undefined, kind: MonitorPathKind): string[] {
  const repositoryRoot = REPOSITORY_ROOTS[kind];
  const tempRoot = path.resolve(os.tmpdir());

  return parseCommaSeparatedPaths(value, DEFAULT_PATHS[kind]).map((entry) => {
    const resolvedPath = path.resolve(entry);
    const isAllowedPath =
      isPathInside(resolvedPath, repositoryRoot) || isPathInside(resolvedPath, tempRoot);

    if (!isAllowedPath) {
      throw new Error(`${kind} path は ${repositoryRoot} 配下に配置してください: ${resolvedPath}`);
    }

    return resolvedPath;
  });
}
