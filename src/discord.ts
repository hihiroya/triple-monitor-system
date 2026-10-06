import { createHash } from "node:crypto";
import type { MonitorItem, MonitorSource } from "./types.js";
import { logger } from "./logger.js";
import { fetchWithTimeout, getRequiredEnv, HttpRequestError } from "./utils.js";

const MAX_DISCORD_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const NOTIFICATION_TIMEOUT_MS = 90_000;
const MAX_RETRY_WAIT_MS = 30_000;

interface DiscordEmbed {
  title: string;
  description: string;
  url?: string;
  timestamp?: string;
}

interface DiscordPayload {
  embeds: DiscordEmbed[];
}

/**
 * Discord の retry-after ヘッダから待機時間を計算する。
 *
 * Discord は秒数または日時形式で返す可能性があるため、どちらにも対応する。
 */
function getRetryDelayMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return 1_000;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1_000;
  }

  const retryAt = new Date(retryAfter).getTime();
  if (!Number.isNaN(retryAt)) {
    return Math.max(retryAt - Date.now(), 0);
  }

  return 1_000;
}

/** A retry wait shares the notification deadline and always releases its timer. */
async function waitBeforeRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(new Error("notification deadline exceeded"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else timer = setTimeout(resolve, delayMs);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/**
 * Discord webhook へ 1 件の通知を送信する。
 *
 * 20秒/要求、90秒/通知、最大3試行、累積30秒の429待機予算を適用する。
 * 通知に失敗した場合は例外を投げ、runner 側で state を進めないようにする。
 */
export async function notifyDiscord(source: MonitorSource, item: MonitorItem): Promise<void> {
  const webhookUrl = getRequiredEnv(source.webhookEnvName);
  const description = item.url ? `${item.title}\n${item.url}` : item.title;
  const embed: DiscordEmbed = {
    title: source.label,
    description
  };

  if (item.url) {
    embed.url = item.url;
  }
  if (item.timestamp) {
    embed.timestamp = item.timestamp;
  }

  const payload: DiscordPayload = {
    embeds: [embed]
  };

  const itemIdentifier = createHash("sha256").update(item.id).digest("hex");
  const started = performance.now();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), NOTIFICATION_TIMEOUT_MS);
  let cumulativeWaitMs = 0;
  let attempt = 0;
  let status: number | undefined;
  let stage = "headers";
  let waitMs = 0;
  const elapsed = () => performance.now() - started;
  const diagnostic = (event: string, reason = "none") =>
    `Discord notification: event=${event} source=${JSON.stringify(source.key)} item_sha256=${itemIdentifier} attempt=${attempt} status=${status ?? "unknown"} wait_seconds=${waitMs / 1_000} cumulative_wait_seconds=${cumulativeWaitMs / 1_000} elapsed_ms=${Math.round(elapsed())} stage=${stage} reason=${reason}`;
  try {
    for (attempt = 1; attempt <= MAX_DISCORD_ATTEMPTS; attempt += 1) {
      status = undefined;
      stage = "headers";
      waitMs = 0;
      const remaining = NOTIFICATION_TIMEOUT_MS - elapsed();
      if (remaining <= 0 || controller.signal.aborted) throw new Error("total-timeout");
      logger.info(diagnostic("request"));
      const response = await fetchWithTimeout(
        webhookUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        },
        Math.min(REQUEST_TIMEOUT_MS, remaining),
        (nextStage, nextStatus) => {
          stage = nextStage;
          status = nextStatus;
          if (nextStage === "body") logger.info(diagnostic("headers-received"));
        }
      );
      if (elapsed() >= NOTIFICATION_TIMEOUT_MS || controller.signal.aborted) {
        throw new Error("total-timeout");
      }
      if (response.ok) {
        stage = "complete";
        logger.info(diagnostic("success"));
        return;
      }
      stage = "http-status";
      if (response.status !== 429) throw new Error("http-status");
      if (attempt === MAX_DISCORD_ATTEMPTS) throw new Error("attempt-limit");
      stage = "retry-wait";
      waitMs = getRetryDelayMs(response);
      if (waitMs > MAX_RETRY_WAIT_MS - cumulativeWaitMs) throw new Error("wait-budget");
      if (waitMs >= NOTIFICATION_TIMEOUT_MS - elapsed()) throw new Error("total-timeout");
      cumulativeWaitMs += waitMs;
      logger.info(diagnostic("retry-wait"));
      await waitBeforeRetry(waitMs, controller.signal);
    }
  } catch (error) {
    const reason =
      controller.signal.aborted || elapsed() >= NOTIFICATION_TIMEOUT_MS
        ? "total-timeout"
        : error instanceof HttpRequestError
          ? error.reason
          : "notification-failed";
    // Do not propagate fetch errors or response bodies: they may contain credentials/payloads.
    const detail =
      error instanceof HttpRequestError
        ? error.reason
        : error instanceof Error
          ? error.message
          : "unknown";
    const message = diagnostic("failure", reason === "notification-failed" ? detail : reason);
    logger.warn(message);
    throw new Error(message, { cause: error });
  } finally {
    clearTimeout(deadlineTimer);
  }
}
