import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSources } from "../src/config.js";
import { fetchPublicHtmlSnapshot } from "../src/public-html.js";
import { validateSources } from "../src/source-validator.js";
import { validateRepositoryFiles } from "../src/validate-config.js";
import type { MonitorSource, PublicHtmlListSource, RssSource } from "../src/types.js";

function isRssSource(source: MonitorSource): source is RssSource {
  return source.type === "rss";
}

function requireText(value: string, label: string): void {
  expect(value, `${label} が見つかりません`).not.toBe("");
}

function isTwitterRssUrl(rssUrl: string): boolean {
  return rssUrl.includes("/twitter/user/") || rssUrl.includes("/twitter/keyword/");
}

describe("quality gate helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loadSources は実際の default sources を検証し、enabled な source だけ返す", async () => {
    const rawSources = JSON.parse(await readFile("config/default-sources.json", "utf8")) as unknown;
    const expectedSources = validateSources(rawSources).filter((source) => source.enabled);

    await expect(loadSources()).resolves.toEqual(expectedSources);
    await expect(loadSources("rss")).resolves.toEqual(
      expectedSources.filter((source) => source.type === "rss")
    );
  });

  it("validateRepositoryFiles は実際の config と state を検証する", async () => {
    await expect(validateRepositoryFiles()).resolves.toBeUndefined();
  });

  it("rss-monitor.yml は通常 RSS だけを RSSHub なしで実行する", async () => {
    const workflow = await readFile(".github/workflows/rss-monitor.yml", "utf8");
    const runMonitorIndex = workflow.indexOf("- name: Run RSS monitor");
    const commitStateIndex = workflow.indexOf("- name: Commit state");

    requireText(
      workflow.match(/permissions:\s*\r?\n\s+contents: write/)?.[0] ?? "",
      "contents: write"
    );
    requireText(workflow.match(/npm run monitor:rss:standard/)?.[0] ?? "", "standard RSS script");

    expect(workflow).not.toContain("rsshub:");
    expect(workflow).not.toContain("TWITTER_AUTH_TOKEN");
    expect(runMonitorIndex).toBeGreaterThan(-1);
    expect(commitStateIndex).toBeGreaterThan(runMonitorIndex);
  });

  it("x-twitter-monitor.yml は RSSHub の secret と起動順を安全に保つ", async () => {
    const workflow = await readFile(".github/workflows/x-twitter-monitor.yml", "utf8");
    const rsshubServiceIndex = workflow.indexOf("      rsshub:");
    const checkSecretsIndex = workflow.indexOf("- name: Check RSSHub secrets");
    const waitRssHubIndex = workflow.indexOf("- name: Wait for RSSHub");
    const runMonitorIndex = workflow.indexOf("- name: Run X/Twitter monitor");
    const commitStateIndex = workflow.indexOf("- name: Commit state");

    requireText(
      workflow.match(/permissions:\s*\r?\n\s+contents: write/)?.[0] ?? "",
      "contents: write"
    );
    requireText(
      workflow.match(/image: ghcr\.io\/diygod\/rsshub@sha256:[a-f0-9]{64}/)?.[0] ?? "",
      "RSSHub image digest"
    );
    requireText(
      workflow.match(/TWITTER_AUTH_TOKEN: \$\{\{ secrets\.TWITTER_AUTH_TOKEN \}\}/)?.[0] ?? "",
      "RSSHub token env"
    );
    requireText(workflow.match(/npm run monitor:x-twitter/)?.[0] ?? "", "X/Twitter script");

    expect(rsshubServiceIndex).toBeGreaterThan(-1);
    expect(checkSecretsIndex).toBeGreaterThan(rsshubServiceIndex);
    expect(waitRssHubIndex).toBeGreaterThan(checkSecretsIndex);
    expect(runMonitorIndex).toBeGreaterThan(waitRssHubIndex);
    expect(commitStateIndex).toBeGreaterThan(runMonitorIndex);

    const runMonitorBlock = workflow.slice(runMonitorIndex, commitStateIndex);
    expect(runMonitorBlock).toContain("DISCORD_WEBHOOK_URL_MAIN");
    expect(runMonitorBlock).not.toContain("TWITTER_AUTH_TOKEN");
  });

  it("monitor workflow は GitHub expression を exit に直接渡さない", async () => {
    const workflowPaths = [
      ".github/workflows/rss-monitor.yml",
      ".github/workflows/x-profile-monitor.yml",
      ".github/workflows/notion-monitor.yml",
      ".github/workflows/public-site-monitor.yml",
      ".github/workflows/x-twitter-monitor.yml",
      ".github/workflows/tourism-monitor.yml"
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = await readFile(workflowPath, "utf8");
      expect(workflow).not.toContain("- name: Propagate monitor failure");
      expect(workflow).not.toContain('exit "${{ steps.monitor.outputs.exit_code }}"');
      expect(workflow).not.toContain("EXIT_CODE: ${{ steps.monitor.outputs.exit_code }}");
      expect(workflow).toContain("if: always() && steps.monitor.outcome != 'skipped'");
    }
  });

  it("x-profile-monitor.yml は X profile 監視を定期実行する", async () => {
    const workflow = await readFile(".github/workflows/x-profile-monitor.yml", "utf8");
    const checkSecretsIndex = workflow.indexOf("- name: Check X profile monitor secrets");
    const runMonitorIndex = workflow.indexOf("- name: Run X profile monitor");
    const commitStateIndex = workflow.indexOf("- name: Commit state");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain('cron: "5,35 * * * *"');
    expect(workflow).toContain("TWITTER_AUTH_TOKEN");
    expect(workflow).toContain("DISCORD_WEBHOOK_URL_MAIN");
    expect(workflow).toContain("npm run monitor:x-profile");
    expect(checkSecretsIndex).toBeGreaterThan(-1);
    expect(runMonitorIndex).toBeGreaterThan(checkSecretsIndex);
    expect(commitStateIndex).toBeGreaterThan(runMonitorIndex);
  });

  it("notion-monitor.yml は Notion 監視前に必要な secret を検査する", async () => {
    const workflow = await readFile(".github/workflows/notion-monitor.yml", "utf8");
    const checkSecretsIndex = workflow.indexOf("- name: Check Notion monitor secrets");
    const runMonitorIndex = workflow.indexOf("- name: Run Notion monitor");
    const commitStateIndex = workflow.indexOf("- name: Commit state");

    expect(checkSecretsIndex).toBeGreaterThan(-1);
    expect(runMonitorIndex).toBeGreaterThan(checkSecretsIndex);
    expect(commitStateIndex).toBeGreaterThan(runMonitorIndex);
    expect(workflow).toContain("Missing required secrets");
    expect(workflow).toContain("DISCORD_WEBHOOK_URL_MAIN");
    expect(workflow).toContain("NOTION_TOKEN_MAIN");
  });

  it("X/Twitter RSS source は Actions 内の RSSHub だけを参照する", async () => {
    const rawSources = JSON.parse(await readFile("config/default-sources.json", "utf8")) as unknown;
    const sources = validateSources(rawSources);
    const twitterSources = sources
      .filter(isRssSource)
      .filter((source) => source.enabled)
      .filter((source) => isTwitterRssUrl(source.rssUrl));

    expect(twitterSources.length).toBeGreaterThan(0);
    for (const source of twitterSources) {
      expect(source.key).not.toBe("revuestarlight");
      expect(source.group).toBe("x-twitter");
      expect(source.rssUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:1200\/twitter\/(?:user|keyword)\/[^/]+(?:\/[A-Za-z0-9=&_-]+)?$/
      );
      expect(source.rssUrl).not.toContain("localhost");
      expect(source.rssUrl).not.toContain("TWITTER_AUTH_TOKEN");
    }
  });

  it("通常 RSS source は X/Twitter と別 group で実行される", async () => {
    const rawSources = JSON.parse(await readFile("config/default-sources.json", "utf8")) as unknown;
    const sources = validateSources(rawSources);
    const standardRssSources = sources
      .filter(isRssSource)
      .filter((source) => !isTwitterRssUrl(source.rssUrl));

    expect(standardRssSources.length).toBeGreaterThan(0);
    for (const source of standardRssSources) {
      expect(source.group).toBe("standard-rss");
    }
  });

  it("fetchPublicHtmlSnapshot は公開HTML fixture から list snapshot を作る", async () => {
    const html = await readFile("tests/fixtures/revuestarlight-news-list.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html" }
          })
        )
      )
    );

    const source: PublicHtmlListSource = {
      key: "revuestarlight-news",
      type: "public_html_list_poll",
      label: "スタァライト公式ニュース",
      url: "https://revuestarlight.com/news/",
      webhookEnvName: "DISCORD_WEBHOOK_URL_MAIN",
      enabled: true,
      maxItems: 2,
      selectorStrategy: "revuestarlight_news_list"
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.kind).toBe("list");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]?.url).toMatch(/^https:\/\/revuestarlight\.com\/news\//);
  });

  it("fetchPublicHtmlSnapshot は walkerplus fixture から一覧 item を作る", async () => {
    const html = await readFile("tests/fixtures/walkerplus-event-list.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html" }
          })
        )
      )
    );

    const source: PublicHtmlListSource = {
      key: "walkerplus-art-events",
      type: "public_html_list_poll",
      label: "Walkerplus 関東の美術展・博物展",
      url: "https://www.walkerplus.com/event_list/ar0300/eg0107/",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      maxItems: 2,
      selectorStrategy: "walkerplus_event_list"
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.kind).toBe("list");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]?.url).toMatch(/^https:\/\/www\.walkerplus\.com\/event\//);
  });

  it("fetchPublicHtmlSnapshot は artscape fixture から一覧 item を作る", async () => {
    const html = await readFile("tests/fixtures/artscape-exhibition-list.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html" }
          })
        )
      )
    );

    const source: PublicHtmlListSource = {
      key: "artscape-kantou-exhibitions",
      type: "public_html_list_poll",
      label: "artscape 関東地方の展覧会・展示会",
      url: "https://artscape.jp/exhibitions/?area=kantou",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      maxItems: 2,
      selectorStrategy: "artscape_exhibition_list"
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.kind).toBe("list");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]?.url).toMatch(/^https:\/\/artscape\.jp\/exhibitions\/\d+\/$/);
  });

  it("fetchPublicHtmlSnapshot は Science Portal fixture から一覧 item を作る", async () => {
    const html = await readFile("tests/fixtures/scienceportal-event-list.html", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html" }
          })
        )
      )
    );

    const source: PublicHtmlListSource = {
      key: "scienceportal-exhibition-events",
      type: "public_html_list_poll",
      label: "Science Portal 展示・イベント",
      url: "https://scienceportal.jst.go.jp/events/?s_held_month=all&s_category=exhibition,event&exclude_finished",
      webhookEnvName: "DISCORD_WEBHOOK_URL_TOURISM",
      enabled: true,
      maxItems: 2,
      selectorStrategy: "scienceportal_event_list"
    };

    const snapshot = await fetchPublicHtmlSnapshot(source);

    expect(snapshot.kind).toBe("list");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]?.url).toMatch(/^https:\/\/scienceportal\.jst\.go\.jp\/events\/\d+\/$/);
  });
});
