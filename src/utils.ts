const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * unknown の例外値をログ用の文字列に変換する。
 */
export function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 必須環境変数を取得する。
 *
 * webhook URL や Notion token は設定ファイルに直接置かず、未設定なら即失敗させる。
 */
export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`必要な環境変数 ${name} が設定されていません`);
  }
  return value;
}

/**
 * 相対 URL を baseUrl から絶対 URL に変換する。
 *
 * HTML 監視では壊れた href を安全にスキップできるよう、変換不能なら undefined を返す。
 */
export function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * AbortController で timeout 付き fetch を実行する。
 *
 * 外部サイトや API が応答しない場合でも GitHub Actions を長時間占有しないようにする。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`HTTPリクエストがタイムアウトしました: ${url}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP レスポンスを text として取得する。
 *
 * 失敗時は status と短い body を含め、Actions ログから原因を追いやすくする。
 */
export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? ` body=${body.slice(0, 300)}` : "";
    throw new Error(`HTTPエラー: ${response.status} ${response.statusText} url=${url}${detail}`);
  }
  return response.text();
}

/**
 * 取得件数の上限を決める。
 *
 * 大量通知や外部サイトへの過剰アクセスを避けるため、設定値は小さな範囲に制限する。
 */
export function clampMaxItems(value: number | undefined): number {
  if (value === undefined) {
    return 20;
  }
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("maxItems は 1 以上 100 以下の整数である必要があります");
  }
  return value;
}
