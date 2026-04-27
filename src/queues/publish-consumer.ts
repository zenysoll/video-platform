/**
 * Publish queue consumer.
 *
 * For each message:
 * 1. Idempotency — skip if job already 'published'.
 * 2. Transition job to 'publishing'.
 * 3. Fetch rendered video from R2_ADMIN.
 * 4. POST video to Telegram channel via publisher bot (sendVideo).
 * 5. Transition job to 'published', persist telegram_message_id.
 * 6. Increment stream.videos_published counter.
 * 7. Sleep 1 100 ms before next message (Telegram: ≤1 msg/sec per chat).
 *
 * Failure handling:
 * - Transient error  → reset to 'rendered', msg.retry() (up to max_attempts).
 * - Terminal failure → set 'failed', increment videos_failed, msg.ack().
 *
 * Security: PUBLISHER_BOT_TOKEN is only read here, never in queue payloads.
 */

import type { Env } from '../config/env.js';
import type { PublishJobMessage } from './publish-producer.js';
import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/idempotency.js';

/** Telegram rate limit: one message per second per chat. */
const TELEGRAM_RATE_LIMIT_MS = 1_100;

/** Telegram sendVideo caption limit. */
const CAPTION_MAX_CHARS = 1_024;

export async function handlePublishBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  logger.info('publish batch received', {
    queue: batch.queue,
    count: batch.messages.length,
  });

  for (let i = 0; i < batch.messages.length; i++) {
    const msg = batch.messages[i]!;
    const body = msg.body as Partial<PublishJobMessage>;

    if (body.version !== 1 || !body.job_id) {
      logger.warn('publish message malformed', { id: msg.id });
      msg.ack();
      continue;
    }

    const published = await publishJob(body as PublishJobMessage, env);

    if (published === 'ok' || published === 'skip') {
      msg.ack();
    } else {
      // 'retry' — CF Queues will re-deliver up to max_retries.
      msg.retry();
    }

    // Rate limit: pause between messages (skip after last message).
    if (i < batch.messages.length - 1) {
      await sleep(TELEGRAM_RATE_LIMIT_MS);
    }
  }
}

// ── Core publish logic ────────────────────────────────────────────────────────

type PublishResult = 'ok' | 'skip' | 'retry';

async function publishJob(
  msg: PublishJobMessage,
  env: Env,
): Promise<PublishResult> {
  const { job_id, stream_id, channel_id, r2_key, prompt_text } = msg;

  // Load job — idempotency + attempt tracking.
  const job = await env.DB
    .prepare(`
      SELECT id, state, publish_attempts, max_attempts, telegram_message_id
      FROM jobs WHERE id = ?
    `)
    .bind(job_id)
    .first<{
      id: string;
      state: string;
      publish_attempts: number;
      max_attempts: number;
      telegram_message_id: string | null;
    }>();

  if (!job) {
    logger.warn('publish job not found', { job_id });
    return 'skip';
  }

  // Already published — idempotent.
  if (job.state === 'published' || job.telegram_message_id) {
    logger.debug('job already published, skipping', { job_id, state: job.state });
    return 'skip';
  }

  // Not in a publishable state.
  if (job.state !== 'rendered') {
    logger.warn('job not in rendered state, skipping', { job_id, state: job.state });
    return 'skip';
  }

  const now = nowIso();
  const newAttempts = job.publish_attempts + 1;
  const isTerminal = newAttempts >= job.max_attempts;

  // Transition → publishing.
  await env.DB
    .prepare(`
      UPDATE jobs
      SET state = 'publishing',
          publish_attempts = ?,
          publish_started_at = ?
      WHERE id = ? AND state = 'rendered'
    `)
    .bind(newAttempts, now, job_id)
    .run();

  try {
    // Fetch video bytes from R2.
    const r2Object = await env.R2_ADMIN.get(r2_key);
    if (!r2Object) {
      throw new Error(`R2 object not found: ${r2_key}`);
    }
    const videoBytes = await r2Object.arrayBuffer();

    // Send to Telegram.
    const telegramMsgId = await sendVideoToTelegram(
      env.PUBLISHER_BOT_TOKEN,
      channel_id,
      videoBytes,
      prompt_text,
    );

    // Transition → published.
    await env.DB
      .prepare(`
        UPDATE jobs
        SET state = 'published',
            telegram_message_id = ?,
            publish_completed_at = ?
        WHERE id = ?
      `)
      .bind(String(telegramMsgId), nowIso(), job_id)
      .run();

    // Atomic stream counter.
    await env.DB
      .prepare('UPDATE streams SET videos_published = videos_published + 1 WHERE id = ?')
      .bind(stream_id)
      .run();

    logger.info('job published', {
      job_id,
      stream_id,
      channel_id,
      telegram_message_id: telegramMsgId,
    });

    return 'ok';

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('publish failed', { job_id, stream_id, attempt: newAttempts, error: errorMsg });

    if (isTerminal) {
      // Permanent failure — give up.
      await env.DB
        .prepare(`
          UPDATE jobs SET state = 'failed', error_message = ?, failed_at = ? WHERE id = ?
        `)
        .bind(errorMsg.slice(0, 500), nowIso(), job_id)
        .run();
      await env.DB
        .prepare('UPDATE streams SET videos_failed = videos_failed + 1 WHERE id = ?')
        .bind(stream_id)
        .run();
      logger.warn('job permanently failed after max publish attempts', {
        job_id,
        attempts: newAttempts,
      });
      return 'skip'; // ack — no point retrying
    }

    // Transient failure — reset to 'rendered' so the retry can re-enter.
    await env.DB
      .prepare(`UPDATE jobs SET state = 'rendered' WHERE id = ?`)
      .bind(job_id)
      .run();
    return 'retry';
  }
}

// ── Telegram sendVideo ────────────────────────────────────────────────────────

async function sendVideoToTelegram(
  botToken: string,
  chatId: string,
  videoBytes: ArrayBuffer,
  caption: string,
): Promise<number> {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(
    'video',
    new Blob([videoBytes], { type: 'video/mp4' }),
    'video.mp4',
  );
  form.append('caption', caption.slice(0, CAPTION_MAX_CHARS));
  form.append('supports_streaming', 'true');

  const resp = await fetch(
    `https://api.telegram.org/bot${botToken}/sendVideo`,
    { method: 'POST', body: form },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Telegram sendVideo ${resp.status}: ${text.slice(0, 300)}`);
  }

  const result = await resp.json() as { ok: boolean; result?: { message_id: number } };
  if (!result.ok || !result.result?.message_id) {
    throw new Error(`Telegram sendVideo returned ok=false: ${JSON.stringify(result)}`);
  }

  return result.result.message_id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
