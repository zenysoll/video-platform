/**
 * Password verification using PBKDF2 via the Web Crypto API.
 *
 * Format of ACCESS_PASSWORD_HASH:
 *   pbkdf2:sha256:<iterations>:<salt_hex>:<hash_hex>
 *
 * This format is fully verifiable inside Cloudflare Workers (no Node.js modules needed).
 * The hash was generated with 100,000 iterations of PBKDF2-SHA256.
 */

export async function verifyPassword(
  candidate: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') {
    return false;
  }

  const iterations = parseInt(parts[2] ?? '0', 10);
  const saltHex = parts[3] ?? '';
  const expectedHex = parts[4] ?? '';

  if (!iterations || !saltHex || !expectedHex) return false;

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(candidate),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const salt = hexToBytes(saltHex);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    256,
  );

  const derivedHex = bytesToHex(new Uint8Array(derived));

  // Timing-safe comparison
  return timingSafeEqual(derivedHex, expectedHex);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}
