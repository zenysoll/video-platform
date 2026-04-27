/**
 * Stream launch queue producer.
 *
 * Enqueues a stream launch message. The consumer picks it up,
 * generates the first batch of prompts, creates job records,
 * and enqueues render jobs.
 */

import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/idempotency.js';

export interface StreamLaunchMessage {
  version: 1;
  stream_id: string;
  user_id: number;
  /** Which batch this is (0-based). Used for windowed generation. */
  batch_index: number;
  /** How many prompts to generate in this batch. */
  batch_size: number;
  /** Sequence number of the first job in this batch (1-based). */
  seq_start: number;
  enqueued_at: string;
}

export async function enqueueStreamLaunch(
  queue: Queue,
  payload: Omit<StreamLaunchMessage, 'version' | 'enqueued_at'>,
): Promise<void> {
  const message: StreamLaunchMessage = {
    version: 1,
    enqueued_at: nowIso(),
    ...payload,
  };

  await queue.send(message, { contentType: 'json' });

  logger.info('stream launch enqueued', {
    stream_id: payload.stream_id,
    batch_index: payload.batch_index,
    batch_size: payload.batch_size,
    seq_start: payload.seq_start,
  });
}
