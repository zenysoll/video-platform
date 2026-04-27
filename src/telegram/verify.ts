/**
 * Telegram webhook signature verification.
 *
 * Telegram sends the `secret_token` value (set during setWebhook) in the
 * `X-Telegram-Bot-Api-Secret-Token` header of every webhook request.
 *
 * We compare it using a timing-safe equality check to prevent timing attacks.
 * The bot token itself is never transmitted in webhook headers.
 */

const HEADER_NAME = 'X-Telegram-Bot-Api-Secret-Token';

/**
 * Returns true if the request carries the correct secret token.
 *
 * Does NOT read the body — body parsing happens after this check passes.
 * Returns false (not throws) so the router controls the HTTP response.
 */
export async function verifyTelegramSignature(
  request: Request,
  expectedSecret: string,
): Promise<boolean> {
  const receivedSecret = request.headers.get(HEADER_NAME);

  if (receivedSecret === null) {
    return false;
  }

  const enc = new TextEncoder();
  const a = enc.encode(receivedSecret);
  const b = enc.encode(expectedSecret);

  // Lengths must match before timing-safe comparison.
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  // Use Web Crypto for constant-time comparison.
  // We derive HMAC keys so that crypto.subtle.verify does the comparison.
  const key = await crypto.subtle.importKey(
    'raw',
    b,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, a);

  // Re-sign `b` itself to get a reference we can compare against.
  const reference = await crypto.subtle.sign('HMAC', key, b);

  // Constant-time comparison of the two signatures.
  return crypto.subtle.timingSafeEqual !== undefined
    ? crypto.subtle.timingSafeEqual(signature, reference)
    : constantTimeEqual(new Uint8Array(signature), new Uint8Array(reference));
}

/** Fallback constant-time comparison for environments without timingSafeEqual. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
