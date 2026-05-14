/**
 * Cron reaper — runs every 15 minutes via Cloudflare scheduled trigger.
 *
 * Six sweeps per run:
 *
 * 1. Stuck rendering jobs
 *    Jobs stuck in 'rendering' for > RENDER_TIMEOUT_MIN are reset to 'pending'
 *    so the GPU worker (or the next available worker) can reclaim them.
 *
 * 2. Orphaned Vast instances
 *    Streams in 'running' state where all jobs are terminal (rendered/published/failed/cancelled)
 *    but the instance never sent the /done signal.
 *    → mark stream 'completed', destroy the Vast instance.
 *
 * 2b. Error instances (CDI/OCI failure — container never started)
 *    Streams with a real numeric vast_instance_id, no work done (videos_rendered=0,
 *    videos_failed=0), started > ERROR_INSTANCE_TIMEOUT_MIN ago.
 *    The Vast.ai actual_status will be 'error'/'exited'/'created' (never 'running'/'loading').
 *    → destroy instance, reset vast_instance_id to NULL so sweep 3 can retry provisioning.
 *
 * 3. Stuck provisioning (vast_instance_id = 'pending')
 *    Streams stuck in provisioning for > PROVISION_TIMEOUT_MIN (queue worker crashed/timed out).
 *    → reset vast_instance_id to NULL so next queue message can retry provisioning.
 *    → re-enqueue a stream launch message with batch_index=0 to trigger provisioning.
 *
 * 4. Stuck queued streams
 *    Streams stuck in 'queued' for > QUEUED_TIMEOUT_MIN — the stream-queue consumer
 *    never picked up the message (consumer not yet active, CF infra hiccup, or message
 *    expired). Re-enqueue a fresh batch_index=0 message so the consumer can try again.
 *
 * 5. Ghost streams (safety net)
 *    Streams in 'running' state started > STREAM_TIMEOUT_HOURS ago are logged as alerts.
 *    These need human investigation before auto-termination.
 */

import type { Env } from '../config/env.js';
import { VastClient } from '../vast/client.js';
import { enqueueStreamLaunch } from '../queues/stream-producer.js';
import { enqueuePublishJob } from '../queues/publish-producer.js';
import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/idempotency.js';

/** Jobs stuck in 'rendering' longer than this are reset to 'pending'. */
const RENDER_TIMEOUT_MIN = 25;

/** Streams stuck in 'pending' provisioning longer than this are reset and retried. */
const PROVISION_TIMEOUT_MIN = 5;

/** Streams stuck in 'queued' longer than this are re-enqueued (consumer missed the message). */
const QUEUED_TIMEOUT_MIN = 5;

/** Streams running longer than this trigger an alert log. */
const STREAM_TIMEOUT_HOURS = 6;

/**
 * Streams with a real instance ID and no work done after this threshold are
 * checked against the Vast.ai API. CDI/OCI failures keep actual_status as
 * 'error' or 'created' indefinitely and never advance to 'running'.
 */
const ERROR_INSTANCE_TIMEOUT_MIN = 10;

export async function runReaper(env: Env): Promise<void> {
  logger.info('reaper run started');

  // Sweeps 1-5 + 2b run in parallel; sweep 6 (ghost alert) runs after for cleaner logging.
  const [stuck, orphaned, provisioning, renderedStuck, queuedStuck, errorInstances] = await Promise.all([
    sweepStuckRenderingJobs(env),
    sweepOrphanedInstances(env),
    sweepStuckProvisioning(env),
    sweepStuckRenderedJobs(env),
    sweepStuckQueuedStreams(env),
    sweepErrorInstances(env),
  ]);
  const ghosts = await sweepGhostStreams(env);

  logger.info('reaper run complete', { stuck, orphaned, provisioning, renderedStuck, queuedStuck, errorInstances, ghosts });
}

// ── Sweep 1: stuck rendering jobs ────────────────────────────────────────────

async function sweepStuckRenderingJobs(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - RENDER_TIMEOUT_MIN * 60_000).toISOString();

  const stuckJobs = await env.DB
    .prepare(`
      SELECT id, stream_id, render_attempts, max_attempts
      FROM jobs
      WHERE state = 'rendering'
        AND render_started_at < ?
    `)
    .bind(cutoff)
    .all<{ id: string; stream_id: string; render_attempts: number; max_attempts: number }>();

  if (!stuckJobs.results.length) return 0;

  logger.warn('reaper: stuck rendering jobs found', {
    count: stuckJobs.results.length,
    cutoff,
  });

  let reset = 0;
  for (const job of stuckJobs.results) {
    const isTerminal = job.render_attempts >= job.max_attempts;
    const newState = isTerminal ? 'failed' : 'pending';

    await env.DB
      .prepare(`
        UPDATE jobs
        SET state = ?,
            error_message = 'Render timeout — reset by reaper',
            failed_at = CASE WHEN ? THEN ? ELSE NULL END
        WHERE id = ? AND state = 'rendering'
      `)
      .bind(newState, isTerminal ? 1 : 0, nowIso(), job.id)
      .run();

    if (isTerminal) {
      await env.DB
        .prepare('UPDATE streams SET videos_failed = videos_failed + 1 WHERE id = ?')
        .bind(job.stream_id)
        .run();
    }

    logger.info('reaper: job reset', {
      job_id: job.id,
      stream_id: job.stream_id,
      new_state: newState,
      attempts: job.render_attempts,
    });
    reset++;
  }

  return reset;
}

// ── Sweep 2: orphaned Vast instances ─────────────────────────────────────────

async function sweepOrphanedInstances(env: Env): Promise<number> {
  // Find running streams where all jobs are done but instance wasn't destroyed.
  const orphans = await env.DB
    .prepare(`
      SELECT s.id, s.vast_instance_id, s.total_videos,
             s.videos_rendered, s.videos_published, s.videos_failed
      FROM streams s
      WHERE s.state = 'running'
        AND s.vast_instance_id IS NOT NULL
        AND s.vast_instance_id != 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.stream_id = s.id
            AND j.state IN ('pending', 'rendering')
        )
    `)
    .all<{
      id: string;
      vast_instance_id: string;
      total_videos: number;
      videos_rendered: number;
      videos_published: number;
      videos_failed: number;
    }>();

  if (!orphans.results.length) return 0;

  logger.warn('reaper: orphaned vast instances found', { count: orphans.results.length });

  const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
  let destroyed = 0;

  for (const stream of orphans.results) {
    // Mark completed first (idempotent guard).
    await env.DB
      .prepare(`
        UPDATE streams
        SET state = 'completed', completed_at = ?
        WHERE id = ? AND state = 'running'
      `)
      .bind(nowIso(), stream.id)
      .run();

    // Destroy Vast instance.
    const instanceId = parseInt(stream.vast_instance_id, 10);
    if (!isNaN(instanceId)) {
      try {
        await vast.destroyInstance(instanceId);
        logger.info('reaper: vast instance destroyed', {
          stream_id: stream.id,
          instance_id: instanceId,
        });
        destroyed++;
      } catch (err) {
        // Instance may already be gone — log and continue.
        logger.warn('reaper: failed to destroy instance (may be gone already)', {
          stream_id: stream.id,
          instance_id: instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return destroyed;
}

// ── Sweep 2b: error instances (CDI/OCI failure, container never reached 'running') ──

/**
 * Detects streams whose Vast instance failed at the container-runtime level
 * (e.g. CDI GPU injection error). These instances get stuck at actual_status='error'
 * or remain at 'created' indefinitely — bootstrap.sh never runs, no signal is sent,
 * and no jobs complete, so none of the other sweeps catch them.
 *
 * Idempotent: UPDATE uses a conditional WHERE clause on vast_instance_id so
 * a duplicate invocation on an already-reset row is a safe no-op.
 */
async function sweepErrorInstances(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - ERROR_INSTANCE_TIMEOUT_MIN * 60_000).toISOString();

  // Streams with a real (numeric) instance ID, no rendered/failed work yet,
  // and old enough that a healthy boot would have completed by now.
  const candidates = await env.DB
    .prepare(`
      SELECT s.id, s.vast_instance_id
      FROM streams s
      WHERE s.state = 'running'
        AND s.vast_instance_id IS NOT NULL
        AND s.vast_instance_id != 'pending'
        AND s.videos_rendered = 0
        AND s.videos_failed = 0
        AND s.started_at < ?
    `)
    .bind(cutoff)
    .all<{ id: string; vast_instance_id: string }>();

  if (!candidates.results.length) return 0;

  logger.warn('reaper: checking instances for CDI/OCI error state', {
    count: candidates.results.length,
    cutoff,
  });

  const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
  let reset = 0;

  for (const stream of candidates.results) {
    const instanceId = parseInt(stream.vast_instance_id, 10);
    if (isNaN(instanceId)) continue;

    const status = await vast.getInstanceStatus(instanceId);

    // Healthy states that should not be disturbed.
    const isHealthy = status === 'running' || status === 'loading';
    if (isHealthy) continue;

    // Bad states: 'error', 'exited', 'created' (stuck), or null (instance gone).
    logger.warn('reaper: instance in error/dead state — resetting stream for retry', {
      stream_id: stream.id,
      instance_id: instanceId,
      actual_status: status ?? 'gone',
    });

    // Destroy the instance; ignore errors — it may already be gone.
    try {
      await vast.destroyInstance(instanceId);
      logger.info('reaper: error instance destroyed', {
        stream_id: stream.id,
        instance_id: instanceId,
      });
    } catch (err) {
      logger.warn('reaper: failed to destroy error instance (may already be gone)', {
        stream_id: stream.id,
        instance_id: instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Reset vast_instance_id to NULL so sweep 3 / the next provisioning cycle
    // can claim this stream and retry. Conditional WHERE guards against races.
    await env.DB
      .prepare(`UPDATE streams SET vast_instance_id = NULL WHERE id = ? AND vast_instance_id = ?`)
      .bind(stream.id, stream.vast_instance_id)
      .run();

    reset++;
  }

  return reset;
}

// ── Sweep 3: stuck provisioning ──────────────────────────────────────────────
// Catches two stuck states:
//   A) vast_instance_id = 'pending' > PROVISION_TIMEOUT_MIN  (API hung, reset + retry)
//   B) vast_instance_id IS NULL  (all offers failed, provisioning returned early — invisible to A)

async function sweepStuckProvisioning(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - PROVISION_TIMEOUT_MIN * 60_000).toISOString();

  // Case A: stuck in 'pending' for too long (previous worker hung mid-call).
  const pendingStreams = await env.DB
    .prepare(`
      SELECT id, user_id, total_videos
      FROM streams
      WHERE state = 'running'
        AND vast_instance_id = 'pending'
        AND started_at < ?
    `)
    .bind(cutoff)
    .all<{ id: string; user_id: number; total_videos: number }>();

  // Case B: vast_instance_id IS NULL but stream is running and has pending jobs.
  // This happens when all offers fail and provisionVastInstance returns early.
  const nullStreams = await env.DB
    .prepare(`
      SELECT s.id, s.user_id, s.total_videos
      FROM streams s
      WHERE s.state = 'running'
        AND s.vast_instance_id IS NULL
        AND s.started_at < ?
        AND EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.stream_id = s.id AND j.state = 'pending'
        )
    `)
    .bind(cutoff)
    .all<{ id: string; user_id: number; total_videos: number }>();

  const allStuck = [...pendingStreams.results, ...nullStreams.results];

  if (!allStuck.length) return 0;

  logger.warn('reaper: streams need provisioning retry', {
    pending_count: pendingStreams.results.length,
    null_count: nullStreams.results.length,
  });

  let retried = 0;
  for (const stream of allStuck) {
    // Reset to NULL so provisionVastInstance can claim it cleanly.
    await env.DB
      .prepare(`UPDATE streams SET vast_instance_id = NULL WHERE id = ?`)
      .bind(stream.id)
      .run();

    // Re-enqueue a provisioning-only message (batch_index=99 signals provision-only).
    // stream-consumer will skip prompt generation and go straight to provisioning.
    try {
      await enqueueStreamLaunch(env.STREAM_QUEUE, {
        stream_id: stream.id,
        user_id: stream.user_id,
        batch_index: 99,  // sentinel: provision-only, skip prompt gen
        batch_size: 0,
        seq_start: 0,
      });
      logger.info('reaper: re-enqueued provisioning', { stream_id: stream.id });
      retried++;
    } catch (err) {
      logger.error('reaper: failed to re-enqueue for provisioning', {
        stream_id: stream.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return retried;
}

// ── Sweep 4: stuck rendered jobs ─────────────────────────────────────────────

/**
 * Jobs stuck in 'rendered' for > 5 min: PUBLISH_QUEUE.send() likely failed
 * (network blip, queue quota). Re-enqueue them to the publish queue.
 */
async function sweepStuckRenderedJobs(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();

  const stuckJobs = await env.DB
    .prepare(`
      SELECT j.id, j.stream_id, j.prompt_text, j.r2_key, j.r2_bucket,
             s.channel_id
      FROM jobs j
      JOIN streams s ON s.id = j.stream_id
      WHERE j.state = 'rendered'
        AND j.render_completed_at < ?
    `)
    .bind(cutoff)
    .all<{
      id: string;
      stream_id: string;
      prompt_text: string | null;
      r2_key: string | null;
      r2_bucket: string | null;
      channel_id: string | null;
    }>();

  if (!stuckJobs.results.length) return 0;

  logger.warn('reaper: stuck rendered jobs found', { count: stuckJobs.results.length, cutoff });

  let requeued = 0;
  for (const job of stuckJobs.results) {
    if (!job.prompt_text || !job.channel_id || !job.r2_key) {
      logger.warn('reaper: rendered job missing required fields, skipping', { job_id: job.id });
      continue;
    }
    try {
      await enqueuePublishJob(env.PUBLISH_QUEUE, {
        job_id: job.id,
        stream_id: job.stream_id,
        channel_id: job.channel_id,
        r2_key: job.r2_key,
        r2_bucket: job.r2_bucket ?? 'video-platform-admin',
        prompt_text: job.prompt_text,
      });
      requeued++;
      logger.warn('reaper: re-enqueued stuck rendered job', { job_id: job.id });
    } catch (err) {
      logger.error('reaper: failed to re-enqueue rendered job', {
        job_id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return requeued;
}

// ── Sweep 5: stuck queued streams ────────────────────────────────────────────

/**
 * Streams that have been in 'queued' state for > QUEUED_TIMEOUT_MIN without
 * the stream-queue consumer picking them up. Re-enqueue a fresh batch_index=0
 * message so the consumer can try again on the next delivery attempt.
 *
 * This handles: CF Queues consumer not yet active on a new account, transient
 * message expiry, or consumer crash before ack.
 *
 * Idempotent: processStreamBatch uses INSERT OR IGNORE on jobs, so duplicate
 * messages produce no duplicate rows.
 */
async function sweepStuckQueuedStreams(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - QUEUED_TIMEOUT_MIN * 60_000).toISOString();

  const stuck = await env.DB
    .prepare(`
      SELECT id, user_id, total_videos
      FROM streams
      WHERE state = 'queued'
        AND created_at < ?
    `)
    .bind(cutoff)
    .all<{ id: string; user_id: number; total_videos: number }>();

  if (!stuck.results.length) return 0;

  logger.warn('reaper: streams stuck in queued state — re-enqueuing', {
    count: stuck.results.length,
  });

  let requeued = 0;
  for (const stream of stuck.results) {
    const batchSize = Math.min(
      stream.total_videos,
      parseInt(env.PROMPT_BATCH_SIZE ?? '20', 10),
    );
    try {
      await enqueueStreamLaunch(env.STREAM_QUEUE, {
        stream_id: stream.id,
        user_id: stream.user_id,
        batch_index: 0,
        batch_size: batchSize,
        seq_start: 1,
      });
      logger.info('reaper: re-enqueued stuck queued stream', { stream_id: stream.id });
      requeued++;
    } catch (err) {
      logger.error('reaper: failed to re-enqueue queued stream', {
        stream_id: stream.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return requeued;
}

// ── Sweep 6: ghost streams (alert only) ──────────────────────────────────────

async function sweepGhostStreams(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - STREAM_TIMEOUT_HOURS * 3_600_000).toISOString();

  const ghosts = await env.DB
    .prepare(`
      SELECT id, name, started_at, total_videos, videos_rendered, videos_failed
      FROM streams
      WHERE state = 'running'
        AND started_at < ?
        AND (videos_rendered + videos_failed) < total_videos
    `)
    .bind(cutoff)
    .all<{
      id: string;
      name: string;
      started_at: string;
      total_videos: number;
      videos_rendered: number;
      videos_failed: number;
    }>();

  for (const s of ghosts.results) {
    logger.error('reaper: ghost stream detected — needs investigation', {
      stream_id: s.id,
      name: s.name,
      started_at: s.started_at,
      total_videos: s.total_videos,
      videos_rendered: s.videos_rendered,
      videos_failed: s.videos_failed,
    });
  }

  return ghosts.results.length;
}
