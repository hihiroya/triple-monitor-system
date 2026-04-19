import type { MonitorItem, MonitorSource } from "./types.js";
import { fetchWithTimeout, getRequiredEnv } from "./utils.js";

const MAX_DISCORD_ATTEMPTS = 3;

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

/**
 * rate limit 時の再試行前に待機する。
 *
 * テストでは長時間待たないよう、環境変数で待機時間を差し替えられる。
 */
async function waitBeforeRetry(delayMs: number): Promise<void> {
  if (process.env.DISCORD_RETRY_DELAY_OVERRIDE_MS !== undefined) {
    const overrideMs = Number(process.env.DISCORD_RETRY_DELAY_OVERRIDE_MS);
    if (Number.isFinite(overrideMs) && overrideMs >= 0) {
      await new Promise((resolve) => setTimeout(resolve, overrideMs));
      return;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Discord webhook へ 1 件の通知を送信する。
 *
 * webhook URL は環境変数から取得し、429 rate limit は上限つきで再試行する。
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

  for (let attempt = 1; attempt <= MAX_DISCORD_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      return;
    }

    if (response.status === 429 && attempt < MAX_DISCORD_ATTEMPTS) {
      // Discord が返す retry-after を尊重し、一時的な rate limit では次回実行待ちにしない。
      await waitBeforeRetry(getRetryDelayMs(response));
      continue;
    }

    const body = await response.text().catch(() => "");
    throw new Error(
      `Discord通知に失敗しました: status=${response.status} body=${body.slice(0, 300)}`
    );
  }
}
