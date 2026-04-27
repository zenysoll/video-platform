/**
 * Publish queue producer.
 *
 * Enqueues a publish job message onto the publish-queue.
 * The publish consumer (Phase 5) posts the video to a Telegram channel.
 *
 * Security: PUBLISHER_BOT_TOKEN is never in this payload.
 * The consumer retrieves the token from env at processing time.
 */

import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/idempotency.js';

export interface PublishJobMessage {
  /** Schema version — increment when fields change. */
  version: 1;
  job_id: string;
  stream_id: string;
  /** Telegram channel ID where the video should be published. */
  channel_id: string;
  /** R2 object key of the rendered video. */
  r2_key: string;
  /** R2 bucket name containing the video. */
  r2_bucket: string;
  /** Prompt text to include as the video caption. */
  prompt_text: string;
  enqueued_at: string;  // ISO-8601 UTC
}

export async function enqueuePublishJob(
  queue: Queue,
  payload: Omit<PublishJobMessage, 'version' | 'enqueued_at'>,
): Promise<void> {
  const message: PublishJobMessage = {
    version: 1,
    enqueued_at: nowIso(),
    ...payload,
  };

  await queue.send(message, { contentType: 'json' });

  logger.info('publish job enqueued', {
    job_id: payload.job_id,
    stream_id: payload.stream_id,
    channel_id: payload.channel_id,
    r2_key: payload.r2_key,
  });
}
