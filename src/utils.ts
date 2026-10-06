const DEFAULT_TIMEOUT_MS = 20_000;
const ERROR_BODY_PREVIEW_LIMIT = 2_000;

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

export type HttpStage = "headers" | "body";

export class HttpRequestError extends Error {
  constructor(
    readonly stage: HttpStage,
    readonly status: number | undefined,
    readonly reason: "timeout" | "aborted" | "network"
  ) {
    super(
      `${reason === "timeout" ? "HTTPリクエストがタイムアウトしました" : "HTTPリクエストに失敗しました"}: stage=${stage} status=${status ?? "unknown"} reason=${reason}`
    );
  }
}

/** Buffer the response under one deadline, retaining fetch metadata for callers. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onStage?: (stage: HttpStage, status?: number) => void
): Promise<Response> {
  const controller = new AbortController();
  let stage: HttpStage = "headers";
  let status: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortParent: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    const interrupt = (reason: "timeout" | "aborted") => {
      controller.abort();
      reject(new HttpRequestError(stage, status, reason));
    };
    timer = setTimeout(() => interrupt("timeout"), timeoutMs);
    if (init.signal) {
      abortParent = () => interrupt("aborted");
      init.signal.addEventListener("abort", abortParent, { once: true });
      if (init.signal.aborted) abortParent();
    }
  });
  try {
    return await Promise.race([
      interrupted,
      (async () => {
        onStage?.(stage);
        controller.signal.throwIfAborted();
        const response = await fetch(url, { ...init, signal: controller.signal });
        status = response.status;
        stage = "body";
        onStage?.(stage, status);
        const body = await response.arrayBuffer();
        controller.signal.throwIfAborted();
        const buffered = new Response([204, 205, 304].includes(status) ? null : body, {
          status,
          statusText: response.statusText,
          headers: response.headers
        });
        // Rebuilding the body must not discard redirect metadata.
        for (const key of ["url", "redirected", "type"] as const) {
          Object.defineProperty(buffered, key, { value: response[key] });
        }
        return buffered;
      })()
    ]);
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(stage, status, "network");
  } finally {
    clearTimeout(timer);
    if (abortParent) init.signal?.removeEventListener("abort", abortParent);
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
    const bodyPreview = normalizeWhitespace(body).slice(0, ERROR_BODY_PREVIEW_LIMIT);
    const detail = bodyPreview ? ` body=${bodyPreview}` : "";
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
