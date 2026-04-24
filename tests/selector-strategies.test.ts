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

  it("walkerplus_event_list は一覧本体だけからイベント詳細リンクを抽出する", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "walkerplus-event-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "walkerplus_event_list",
      html,
      "https://www.walkerplus.com/event_list/ar0300/eg0107/",
      10
    );

    expect(items).toEqual([
      {
        id: "https://www.walkerplus.com/event/ar0313e583830/",
        title: "クロード・モネ ー風景への問いかけ",
        url: "https://www.walkerplus.com/event/ar0313e583830/"
      },
      {
        id: "https://www.walkerplus.com/event/ar0313e558982/",
        title: "あそぼうよ！五味太郎 えほんの世界展",
        url: "https://www.walkerplus.com/event/ar0313e558982/"
      },
      {
        id: "https://www.walkerplus.com/event/ar0313e583109/",
        title: "サンリオ展 FINAL ver.(ファイナル バージョン) ニッポンのカワイイ文化60年史",
        url: "https://www.walkerplus.com/event/ar0313e583109/"
      }
    ]);
  });

  it("walkerplus_event_list は maxItems を超えて抽出しない", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "walkerplus-event-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "walkerplus_event_list",
      html,
      "https://www.walkerplus.com/event_list/ar0300/eg0107/",
      2
    );

    expect(items.map((item) => item.id)).toEqual([
      "https://www.walkerplus.com/event/ar0313e583830/",
      "https://www.walkerplus.com/event/ar0313e558982/"
    ]);
  });

  it("enjoytokyo_event_list は JSON-LD の本体一覧だけからイベントを抽出する", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "enjoytokyo-event-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "enjoytokyo_event_list",
      html,
      "https://www.enjoytokyo.jp/event/list/cat04/",
      10
    );

    expect(items).toEqual([
      {
        id: "https://www.enjoytokyo.jp/event/2060940/",
        title: "口にできないチョコレート展 2026-04-10 - 2026-05-15",
        url: "https://www.enjoytokyo.jp/event/2060940/"
      },
      {
        id: "https://www.enjoytokyo.jp/event/1500577/",
        title: "ミニチュア写真の世界展 2026 2026-04-10 - 2026-05-17",
        url: "https://www.enjoytokyo.jp/event/1500577/"
      },
      {
        id: "https://www.enjoytokyo.jp/event/2056459/",
        title: "平成恋愛展 2026-04-07 - 2026-06-28",
        url: "https://www.enjoytokyo.jp/event/2056459/"
      }
    ]);
  });

  it("enjoytokyo_event_list は maxItems を超えて抽出しない", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "enjoytokyo-event-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "enjoytokyo_event_list",
      html,
      "https://www.enjoytokyo.jp/event/list/cat04/",
      2
    );

    expect(items.map((item) => item.id)).toEqual([
      "https://www.enjoytokyo.jp/event/2060940/",
      "https://www.enjoytokyo.jp/event/1500577/"
    ]);
  });

  it("artscape_exhibition_list は一覧本体だけから展覧会詳細リンクを抽出する", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "artscape-exhibition-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "artscape_exhibition_list",
      html,
      "https://artscape.jp/exhibitions/?area=kantou",
      10
    );

    expect(items).toEqual([
      {
        id: "https://artscape.jp/exhibitions/67441/",
        title: "特集展示「モノと身体」 会期：2026年04月21日～2026年05月31日",
        url: "https://artscape.jp/exhibitions/67441/"
      },
      {
        id: "https://artscape.jp/exhibitions/66742/",
        title: "97歳セツの新聞ちぎり絵 原画展 会期：2026年04月18日～2026年07月20日",
        url: "https://artscape.jp/exhibitions/66742/"
      }
    ]);
  });

  it("artscape_exhibition_list は maxItems を超えて抽出しない", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "artscape-exhibition-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "artscape_exhibition_list",
      html,
      "https://artscape.jp/exhibitions/?area=kantou",
      1
    );

    expect(items.map((item) => item.id)).toEqual(["https://artscape.jp/exhibitions/67441/"]);
  });

  it("scienceportal_event_list は埋め込みイベントデータから未終了の展示・イベントだけを抽出する", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "scienceportal-event-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "scienceportal_event_list",
      html,
      "https://scienceportal.jst.go.jp/events/?s_held_month=all&s_category=exhibition,event&exclude_finished",
      10
    );

    expect(items).toEqual([
      {
        id: "https://scienceportal.jst.go.jp/events/19447/",
        title: "AI時代のアーキテクチャ設計 2026.05.21 東京都",
        url: "https://scienceportal.jst.go.jp/events/19447/"
      },
      {
        id: "https://scienceportal.jst.go.jp/events/19446/",
        title: "JAXA エアロスペーススクール2026 参加者募集 2026.07.22 - 2026.08.18 全国",
        url: "https://scienceportal.jst.go.jp/events/19446/"
      },
      {
        id: "https://scienceportal.jst.go.jp/events/19420/",
        title: "科学展示 2026.06.01 - 2026.06.30 大阪府",
        url: "https://scienceportal.jst.go.jp/events/19420/"
      }
    ]);
  });

  it("scienceportal_event_list は maxItems を超えて抽出しない", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "scienceportal-event-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "scienceportal_event_list",
      html,
      "https://scienceportal.jst.go.jp/events/",
      2
    );

    expect(items.map((item) => item.id)).toEqual([
      "https://scienceportal.jst.go.jp/events/19447/",
      "https://scienceportal.jst.go.jp/events/19446/"
    ]);
  });

  it("nmri_mail_news_list はバックナンバー一覧だけからメールニュースを抽出する", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "nmri-mail-news-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "nmri_mail_news_list",
      html,
      "https://www.nmri.go.jp/news/mail_news/",
      10
    );

    expect(items).toEqual([
      {
        id: "https://www.nmri.go.jp/news/mail_news/2026/mail_news232.html",
        title: "令和8年4月3日 No.232",
        url: "https://www.nmri.go.jp/news/mail_news/2026/mail_news232.html"
      },
      {
        id: "https://www.nmri.go.jp/news/mail_news/2026/mail_news231.html",
        title: "令和8年3月18日 No.231",
        url: "https://www.nmri.go.jp/news/mail_news/2026/mail_news231.html"
      },
      {
        id: "https://www.nmri.go.jp/news/mail_news/2026/mail_news230.html",
        title: "令和8年1月16日 No.230",
        url: "https://www.nmri.go.jp/news/mail_news/2026/mail_news230.html"
      },
      {
        id: "https://www.nmri.go.jp/news/mail_news/2025/mail_news229.html",
        title: "令和7年12月24日 No.229",
        url: "https://www.nmri.go.jp/news/mail_news/2025/mail_news229.html"
      },
      {
        id: "https://www.nmri.go.jp/news/mail_news/2024/mail_news_20240926.html",
        title: "令和6年09月26日 号外",
        url: "https://www.nmri.go.jp/news/mail_news/2024/mail_news_20240926.html"
      },
      {
        id: "https://www.nmri.go.jp/news/mail_news/mailnews139.html",
        title: "平成27年07月15日 No.139",
        url: "https://www.nmri.go.jp/news/mail_news/mailnews139.html"
      }
    ]);
  });

  it("nmri_mail_news_list は maxItems を超えて抽出しない", async () => {
    const html = await readFile(
      path.resolve("tests", "fixtures", "nmri-mail-news-list.html"),
      "utf8"
    );

    const items = runSelectorStrategy(
      "nmri_mail_news_list",
      html,
      "https://www.nmri.go.jp/news/mail_news/",
      2
    );

    expect(items.map((item) => item.id)).toEqual([
      "https://www.nmri.go.jp/news/mail_news/2026/mail_news232.html",
      "https://www.nmri.go.jp/news/mail_news/2026/mail_news231.html"
    ]);
  });
});
