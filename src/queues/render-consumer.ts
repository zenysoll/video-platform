/**
 * Render queue consumer.
 *
 * Render jobs are created by stream-consumer and executed by GPU workers
 * that poll the /worker/jobs/claim endpoint. This consumer's role is:
 *
 * 1. Idempotency check — skip if already past 'pending'.
 * 2. Verify the job exists and is still pending (log if not).
 * 3. Acknowledge — the actual rendering happens on the GPU worker.
 *
 * State transitions are driven by the Worker API (/worker/jobs/:id/complete|fail),
 * not by this consumer.
 */

import type { Env } from '../config/env.js';
import type { RenderJobMessage } from './render-producer.js';
import { logger } from '../lib/logger.js';

export async function handleRenderBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  logger.info('render batch received', {
    queue: batch.queue,
    count: batch.messages.length,
  });

  for (const msg of batch.messages) {
    const body = msg.body as Partial<RenderJobMessage>;

    if (body.version !== 1 || !body.job_id) {
      logger.warn('render message malformed', { id: msg.id });
      msg.ack();
      continue;
    }

    // Verify job is still pending (idempotency guard).
    const job = await env.DB
      .prepare('SELECT state FROM jobs WHERE id = ?')
      .bind(body.job_id)
      .first<{ state: string }>();

    if (!job) {
      logger.warn('render job not found in DB', { job_id: body.job_id });
      msg.ack();
      continue;
    }

    if (job.state !== 'pending') {
      logger.debug('render job already processed, skipping', {
        job_id: body.job_id,
        state: job.state,
      });
      msg.ack();
      continue;
    }

    logger.info('render job queued, awaiting GPU worker pickup', {
      job_id: body.job_id,
      stream_id: body.stream_id,
      sequence_num: body.sequence_num,
    });

    msg.ack();
  }
}
