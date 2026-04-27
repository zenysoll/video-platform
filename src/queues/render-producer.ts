/**
 * Render queue producer.
 *
 * Enqueues a render job message onto the render-queue.
 * The GPU worker (Phase 4) will consume this queue to start rendering.
 *
 * Message schema is versioned so consumers can handle future changes gracefully.
 * Secrets (tokens, keys) are never included in queue payloads.
 */

import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/idempotency.js';

export interface RenderJobMessage {
  /** Schema version — increment when fields change. */
  version: 1;
  job_id: string;
  stream_id: string;
  sequence_num: number;
  enqueued_at: string;  // ISO-8601 UTC
}

export async function enqueueRenderJob(
  queue: Queue,
  payload: Omit<RenderJobMessage, 'version' | 'enqueued_at'>,
): Promise<void> {
  const message: RenderJobMessage = {
    version: 1,
    enqueued_at: nowIso(),
    ...payload,
  };

  await queue.send(message, { contentType: 'json' });

  logger.info('render job enqueued', {
    job_id: payload.job_id,
    stream_id: payload.stream_id,
    sequence_num: payload.sequence_num,
  });
}
