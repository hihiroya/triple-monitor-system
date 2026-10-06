import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fetchRssSnapshot } from "../src/rss.js";
import { runSource } from "../src/source-runner.js";
import { loadState, saveState } from "../src/state.js";
import type { MonitorState, RssSource } from "../src/types.js";

vi.mock("../src/rss.js", () => ({ fetchRssSnapshot: vi.fn() }));

let directory: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("keeps the successful notification checkpoint on disk when the next real notifier times out", async () => {
  vi.useFakeTimers();
  directory = await mkdtemp(path.join(os.tmpdir(), "notification-deadlines-"));
  vi.stubEnv("MONITOR_STATE_PATH", path.join(directory, "state.json"));
  vi.stubEnv("TEST_WEBHOOK", "https://example.invalid/webhook");
  const source: RssSource = {
    key: "deadline-checkpoint",
    type: "rss",
    label: "test",
    enabled: true,
    rssUrl: "https://example.invalid/feed",
    webhookEnvName: "TEST_WEBHOOK"
  };
  const state: MonitorState = {
    sources: { [source.key]: { lastSeenItemId: "old", seenItemIds: ["old"] } }
  };
  await saveState(state);
  vi.mocked(fetchRssSnapshot).mockResolvedValue({
    kind: "list",
    items: ["new3", "new2", "new1", "old"].map((id) => ({ id, title: id }))
  });
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockImplementationOnce(() => {
      secondStarted();
      const response = new Response("private body", { status: 429 });
      vi.spyOn(response, "arrayBuffer").mockImplementation(() => new Promise(() => {}));
      return Promise.resolve(response);
    });
  vi.stubGlobal("fetch", fetchMock);
  const pending = runSource(source, state, saveState);
  await started;
  expect((await loadState()).sources[source.key]?.seenItemIds).toEqual(["new1", "old"]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toMatchObject({ ok: false });
  expect((await loadState()).sources[source.key]?.seenItemIds).toEqual(["new1", "old"]);
  expect(state.sources[source.key]?.seenItemIds).toEqual(["new1", "old"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
