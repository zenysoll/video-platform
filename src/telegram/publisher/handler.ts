/**
 * Publisher bot update handler — Phase 1 skeleton.
 *
 * The publisher bot is passive: it does not respond to user commands.
 * Its primary role (posting videos to channels) is driven by the publish-queue
 * consumer, not by incoming webhook updates.
 *
 * This handler logs the update type for observability and returns.
 */

import type { Env } from '../../config/env.js';
import type { TelegramUpdate } from '../types.js';
import { logger } from '../../lib/logger.js';

export async function handlePublisherUpdate(
  update: TelegramUpdate,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _env: Env,
): Promise<void> {
  const type = update.message
    ? 'message'
    : update.callback_query
      ? 'callback_query'
      : update.channel_post
        ? 'channel_post'
        : 'other';

  logger.debug('publisher update received', {
    update_id: update.update_id,
    type,
  });

  // No-op in Phase 1. Publishing logic is added in Phase 5 (publish-queue consumer).
}
