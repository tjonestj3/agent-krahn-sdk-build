import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a GitHub webhook delivery using the HMAC-SHA256 signature in the
 * X-Hub-Signature-256 header. The header value is the literal string
 * "sha256=<hex>". Constant-time compare to avoid timing leaks.
 */
export function verifyGithubRequest(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
  const sigBuf = Buffer.from(signatureHeader);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
