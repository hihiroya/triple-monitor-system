const SECRET_PATTERNS = [
  /https:\/\/discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/[^\s"']+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi
];

function maskSecrets(message: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[secret]"),
    message
  );
}

/**
 * secret マスクを通したログ出力口。
 *
 * logger.ts 以外の console 直書きを ESLint で禁止し、webhook URL や Bearer token が
 * 誤って Actions ログへ出る経路を狭める。
 */
export const logger = {
  info(message: string): void {
    console.log(maskSecrets(message));
  },
  warn(message: string): void {
    console.warn(maskSecrets(message));
  },
  error(message: string): void {
    console.error(maskSecrets(message));
  }
};
