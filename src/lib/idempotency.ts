/**
 * Idempotency key helpers.
 *
 * Uses the Web Crypto API (available in CF Workers without nodejs_compat).
 */

/**
 * Generate a UUID v4 using the Web Crypto API.
 * Safe to call in any Workers context.
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Current timestamp as an ISO-8601 UTC string.
 * All timestamps in this project are stored as ISO-8601 UTC strings.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Derive a deterministic SHA-256 fingerprint from an arbitrary string.
 * Used by the prompt pipeline to detect duplicate prompt briefs.
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
