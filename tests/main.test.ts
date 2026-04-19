import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorSource, MonitorState, SourceRunResult, SourceType } from "../src/types.js";

const rssSource: MonitorSource = {
  key: "rss-main",
  type: "rss",
  label: "RSS",
  rssUrl: "https://example.com/feed.xml",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true
};

const notionSource: MonitorSource = {
  key: "notion-main",
  type: "notion_api_page_poll",
  label: "Notion",
  pageId: "00000000000000000000000000000000",
  notionTokenEnvName: "NOTION_TOKEN_MAIN",
  webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
  enabled: true
};

async function loadMainWithMocks(options: {
  sources: MonitorSource[];
  state: MonitorState;
  results: SourceRunResult[];
}) {
  vi.resetModules();

  const loadSourcesMock = vi.fn<
    (filterType?: SourceType, filterGroup?: string) => Promise<MonitorSource[]>
  >((filterType, filterGroup) =>
    Promise.resolve(
      options.sources.filter(
        (source) =>
          (!filterType || source.type === filterType) &&
          (!filterGroup || source.group === filterGroup)
      )
    )
  );
  const runSourceMock = vi.fn<
    (source: MonitorSource, state: MonitorState) => Promise<SourceRunResult>
  >(() => {
    const result = options.results.shift();
    if (!result) {
      return Promise.reject(new Error("テスト用 result が不足しています"));
    }
    return Promise.resolve(result);
  });
  const loadStateMock = vi.fn<() => Promise<MonitorState>>(() => Promise.resolve(options.state));
  const saveStateMock = vi.fn<(state: MonitorState) => Promise<void>>(() =>
    Promise.resolve(undefined)
  );
  const loggerMock = {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>()
  };

  vi.doMock("../src/config.js", () => ({
    loadSources: loadSourcesMock
  }));
  vi.doMock("../src/source-runner.js", () => ({
    runSource: runSourceMock
  }));
  vi.doMock("../src/state.js", () => ({
    cloneState: (state: MonitorState): MonitorState =>
      JSON.parse(JSON.stringify(state)) as MonitorState,
    loadState: loadStateMock,
    saveState: saveStateMock
  }));
  vi.doMock("../src/logger.js", () => ({
    logger: loggerMock
  }));

  const mainModule = await import("../src/main.js");
  return {
    ...mainModule,
    loadSourcesMock,
    runSourceMock,
    loadStateMock,
    saveStateMock,
    loggerMock
  };
}

describe("main", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("parseTypeArg は有効な type filter を返す", async () => {
    const { parseGroupArg, parseTypeArg } = await loadMainWithMocks({
      sources: [],
      state: { sources: {} },
      results: []
    });

    expect(parseTypeArg(["--type", "rss"])).toBe("rss");
    expect(parseTypeArg([])).toBeUndefined();
    expect(() => parseTypeArg(["--type", "invalid"])).toThrow("--type には");
    expect(parseGroupArg(["--group", "x-twitter"])).toBe("x-twitter");
    expect(parseGroupArg([])).toBeUndefined();
    expect(() => parseGroupArg(["--group", "Invalid"])).toThrow("--group には");
  });

  it("type と group filter を loadSources に渡し、対象 source だけ実行する", async () => {
    const groupedRssSource: MonitorSource = {
      ...rssSource,
      group: "standard-rss"
    };
    const { runMain, loadSourcesMock, runSourceMock } = await loadMainWithMocks({
      sources: [groupedRssSource, notionSource],
      state: { sources: {} },
      results: [
        {
          key: "rss-main",
          ok: true,
          changed: false,
          message: "新着はありません"
        }
      ]
    });

    await runMain(["--type", "rss", "--group", "standard-rss"]);

    expect(loadSourcesMock).toHaveBeenCalledWith("rss", "standard-rss");
    expect(runSourceMock).toHaveBeenCalledTimes(1);
    expect(runSourceMock.mock.calls[0]?.[0]).toMatchObject({ key: "rss-main" });
    expect(process.exitCode).toBeUndefined();
  });

  it("source が state を変更した場合だけ saveState を呼ぶ", async () => {
    const state: MonitorState = { sources: {} };
    const { runMain, saveStateMock } = await loadMainWithMocks({
      sources: [rssSource],
      state,
      results: [
        {
          key: "rss-main",
          ok: true,
          changed: true,
          message: "初回実行"
        }
      ]
    });

    await runMain([]);

    expect(saveStateMock).toHaveBeenCalledWith(state);
  });

  it("部分失敗時も他 source を継続し、最後に exitCode=1 にする", async () => {
    const { runMain, runSourceMock, loggerMock } = await loadMainWithMocks({
      sources: [rssSource, notionSource],
      state: { sources: {} },
      results: [
        {
          key: "rss-main",
          ok: false,
          changed: false,
          message: "rss failed"
        },
        {
          key: "notion-main",
          ok: true,
          changed: false,
          message: "更新はありません"
        }
      ]
    });

    await runMain([]);

    expect(runSourceMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.error).toHaveBeenCalledWith("source 失敗: key=rss-main rss failed");
    expect(process.exitCode).toBe(1);
  });
});
