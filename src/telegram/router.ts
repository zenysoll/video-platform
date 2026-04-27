/**
 * Telegram webhook router.
 *
 * Dispatches incoming webhook requests to the correct bot handler based on URL path.
 * This is the only module that touches CONTROL_BOT_SECRET and PUBLISHER_BOT_SECRET.
 *
 * Important: always returns HTTP 200 to Telegram after signature verification,
 * regardless of processing outcome. Telegram interprets non-2xx as a delivery failure
 * and retries with backoff — we handle retries internally via our queue consumers.
 */

import type { Env } from '../config/env.js';
import { verifyTelegramSignature } from './verify.js';
import type { TelegramUpdate } from './types.js';
import { handleControlUpdate } from './control/handler.js';
import { handlePublisherUpdate } from './publisher/handler.js';
import { logger } from '../lib/logger.js';

export async function handleTelegramRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  let botType: 'control' | 'publisher';
  let secret: string;

  if (path === env.CONTROL_BOT_WEBHOOK_PATH) {
    botType = 'control';
    secret = env.CONTROL_BOT_SECRET;
  } else if (path === env.PUBLISHER_BOT_WEBHOOK_PATH) {
    botType = 'publisher';
    secret = env.PUBLISHER_BOT_SECRET;
  } else {
    return new Response('Not Found', { status: 404 });
  }

  const valid = await verifyTelegramSignature(request, secret);
  if (!valid) {
    logger.warn('webhook signature verification failed', { bot: botType, path });
    return new Response('Unauthorized', { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    logger.warn('failed to parse webhook body', { bot: botType });
    // Still return 200 so Telegram does not retry a malformed payload.
    return new Response('OK', { status: 200 });
  }

  logger.debug('webhook received', { bot: botType, update_id: update.update_id });

  try {
    if (botType === 'control') {
      await handleControlUpdate(update, env);
    } else {
      await handlePublisherUpdate(update, env);
    }
  } catch (err) {
    logger.error('unhandled error in webhook handler', {
      bot: botType,
      update_id: update.update_id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Return 200 regardless — errors are logged and recovered through queues.
  }

  return new Response('OK', { status: 200 });
}
