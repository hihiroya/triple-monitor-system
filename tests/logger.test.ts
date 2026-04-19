import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Discord webhook URL と Bearer token をログ出力前にマスクする", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.info("webhook=https://discord.com/api/webhooks/123456/token-value");
    logger.warn("Authorization: Bearer secret_token_value");
    logger.error("plain message");

    expect(logSpy).toHaveBeenCalledWith("webhook=[secret]");
    expect(warnSpy).toHaveBeenCalledWith("Authorization: [secret]");
    expect(errorSpy).toHaveBeenCalledWith("plain message");
  });
});
