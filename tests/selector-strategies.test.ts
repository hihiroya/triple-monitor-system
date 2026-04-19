import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSelectorStrategy } from "../src/selector-strategies.js";

describe("runSelectorStrategy", () => {
  it("revuestarlight_news_list は同一 origin のニュース詳細リンクだけを抽出する", () => {
    const html = `
      <main>
        <a href="/news/">ニュース一覧</a>
        <a href="/news/10001/">  公演   情報  </a>
        <a href="https://revuestarlight.com/news/10002/">グッズ情報</a>
        <a href="https://outside.example/news/99999/">外部ニュース</a>
        <a href="/about/">概要</a>
        <a href="/news/10001/">重複リンク</a>
        <a href="/news/10003/"></a>
      </main>`;

    const items = runSelectorStrategy(
      "revuestarlight_news_list",
      html,
      "https://revuestarlight.com/news/",
      10
    );

    expect(items).toEqual([
      {
        id: "https://revuestarlight.com/news/10001/",
        title: "公演 情報",
        url: "https://revuestarlight.com/news/10001/"
      },
      {
        id: "https://revuestarlight.com/news/10002/",
        title: "グッズ情報",
        url: "https://revuestarlight.com/news/10002/"
      }
    ]);
  });

  it("maxItems を超えて抽出しない", () => {
    const html = `
      <a href="/news/1/">one</a>
      <a href="/news/2/">two</a>
      <a href="/news/3/">three</a>`;

    const items = runSelectorStrategy(
      "revuestarlight_news_list",
      html,
      "https://revuestarlight.com/news/",
      2
    );

    expect(items.map((item) => item.id)).toEqual([
      "https://revuestarlight.com/news/1/",
      "https://revuestarlight.com/news/2/"
    ]);
  });

  it("実サイトに近い fixture からニュースリンクを安定して抽出する", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "revuestarlight-news-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "revuestarlight_news_list",
      html,
      "https://revuestarlight.com/news/",
      10
    );

    expect(items).toEqual([
      {
        id: "https://revuestarlight.com/news/12345/",
        title: "2026.04.19 舞台公演の最新情報",
        url: "https://revuestarlight.com/news/12345/"
      },
      {
        id: "https://revuestarlight.com/news/12346/",
        title: "2026.04.18 グッズ販売のお知らせ",
        url: "https://revuestarlight.com/news/12346/"
      }
    ]);
  });
});
