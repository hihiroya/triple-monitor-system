import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText, fetchWithTimeout } from "../src/utils.js";

const pendingBody = () => {
  const response = new Response("body");
  vi.spyOn(response, "arrayBuffer").mockImplementation(() => new Promise(() => {}));
  return response;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HTTP deadlines", () => {
  it("uses one 20s budget for headers and body, aborting even an uncooperative reader", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((_, init) => {
        signal = init?.signal;
        return new Promise((resolve) => setTimeout(() => resolve(pendingBody()), 15_000));
      })
    );
    const assertion = expect(fetchWithTimeout("https://example.invalid")).rejects.toMatchObject({
      stage: "body",
      status: 200,
      reason: "timeout"
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds header stalls and releases the timer on network errors", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => new Promise(() => {}))
    );
    const assertion = expect(fetchWithTimeout("https://example.invalid")).rejects.toMatchObject({
      stage: "headers",
      reason: "timeout"
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("private URL")));
    await expect(fetchWithTimeout("https://example.invalid")).rejects.toMatchObject({
      reason: "network"
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("buffers successful responses and preserves metadata and headers", async () => {
    vi.useFakeTimers();
    const response = new Response("hello", { headers: { "x-test": "yes" } });
    Object.defineProperty(response, "url", { value: "https://example.invalid/redirected" });
    Object.defineProperty(response, "redirected", { value: true });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(response));
    const buffered = await fetchWithTimeout("https://example.invalid");
    expect(await buffered.text()).toBe("hello");
    expect(buffered.headers.get("x-test")).toBe("yes");
    expect(buffered.url).toBe(response.url);
    expect(buffered.redirected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fetchText also times out while reading the body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(pendingBody()));
    const assertion = expect(fetchText("https://example.invalid")).rejects.toMatchObject({
      stage: "body",
      reason: "timeout"
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("cancels a real local HTTP stream stalled after headers", async () => {
    let closed = false;
    const server = createServer((_request, response) => {
      response.on("close", () => {
        closed = true;
      });
      response.writeHead(200);
      response.write("partial");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${address.port}`, {}, 150)
      ).rejects.toMatchObject({ stage: "body", reason: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
