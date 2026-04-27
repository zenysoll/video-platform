/**
 * Worker API authentication.
 *
 * GPU workers authenticate using a shared WORKER_SECRET passed in the
 * Authorization header: "Bearer <WORKER_SECRET>".
 *
 * The secret is injected into the Vast instance at startup via env vars.
 * It is never included in queue payloads or Telegram messages.
 */

export function verifyWorkerAuth(request: Request, workerSecret: string): boolean {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);

  // Constant-time comparison.
  if (token.length !== workerSecret.length) return false;
  const enc = new TextEncoder();
  const a = enc.encode(token);
  const b = enc.encode(workerSecret);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function unauthorizedResponse(): Response {
  return new Response('Unauthorized', { status: 401 });
}
