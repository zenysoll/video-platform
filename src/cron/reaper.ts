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
 *
 * 7. Stalled batch chains
 *    Running streams where videos_queued < total_videos (not all prompt batches
 *    were generated) AND no pending jobs remain. Happens when a Gemini transient
 *    outage (429/503) exhausts all 5 CF Queues retries for a batch message → DLQ.
 *    The "enqueue next batch" code in stream-consumer only runs on success, so
 *    subsequent batches are silently lost. Re-enqueue the next missing batch so the
 *    chain can resume once Gemini recovers.
 *
 * 8. Orphan Vast instances (money-leak safety net)
 *    Lists ALL Vast instances owned by the account and destroys any that don't
 *    match a currently-running stream's vast_instance_id and are older than the
 *    provisioning grace window. Catches every leak path regardless of cause:
 *    failed boots whose instance id was lost, cancelled/completed streams whose
 *    instance survived, and re-provision loops that overwrote vast_instance_id and
 *    left the previous instance billing forever. This is the last line of defence
 *    for the GPU budget.
 */

import type { Env } from '../config/env.js';
import { VastClient } from '../vast/client.js';
import { enqueueStreamLaunch } from '../queues/stream-producer.js';
import { enqueuePublishJob } from '../queues/publish-producer.js';
import { telegramCall } from '../telegram/types.js';
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
 * Running streams where videos_queued < total_videos AND no pending jobs
 * AND silent for this long are assumed to have a broken batch chain.
 * Re-enqueue the next missing batch so the chain can resume.
 */
const BATCH_CHAIN_STALL_MIN = 30;

/**
 * Streams with a real instance ID and no work done after this threshold are
 * checked against the Vast.ai API. CDI/OCI failures keep actual_status as
 * 'error' or 'created' indefinitely and never advance to 'running'.
 */
const ERROR_INSTANCE_TIMEOUT_MIN = 10;

/**
 * Grace period before the orphan sweep will destroy a Vast instance that doesn't
 * match any running stream. Protects the race window in runProvisioning between
 * startInstance() (instance exists on Vast) and the D1 UPDATE that records its id
 * (a few seconds). Anything older than this with no owning running stream is a
 * genuine money-leaking orphan and must die.
 */
const ORPHAN_INSTANCE_GRACE_MIN = 12;

/**
 * A running stream whose assigned instance has been up this long but produced NO
 * render progress in this window is treated as a stalled host (bootstrap/worker
 * died silently while the container stays 'running'). The instance is recycled.
 * Generous enough to never touch a still-booting host (slow 55 GB download).
 */
const STALL_RECYCLE_MIN = 40;

/**
 * Absolute give-up: a stream that has been running this long AND is still both
 * incomplete and not making render progress is marked 'failed' (and the user is
 * notified). Bounds the worst case so nothing lingers for days. A progressing
 * stream (recent renders) is NEVER force-failed, regardless of age.
 */
const STREAM_HARD_LIMIT_HOURS = 24;

/**
 * An instance still stuck in 'loading'/'created' (never reached 'running') after
 * this long is recycled. Healthy hosts reach 'running' within a few minutes; a
 * host stuck loading is broken (e.g. "Secrets fetch failed", a wedged Docker pull).
 *
 * Lowered 20 → 10: the pre-built ghcr.io image pulls in ~2-4 min, so 10 min is
 * already generous, and every minute here is dead time the operator watches. With
 * host benching + immediate re-provision, a bad host now costs ~10 min once instead
 * of 35 min on repeat.
 */
const LOADING_STUCK_MIN = 10;

/**
 * Read a minutes threshold from env, falling back to the compiled default.
 * Lets the recycle thresholds be tuned (or driven to 0 for a verification run)
 * with a config change instead of a code deploy.
 */
function minutesFromEnv(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Give a recycled host this long before it can be selected again. Mirrors
 * HOST_FAILURE_COOLDOWN_H in stream-consumer.ts (the reader side).
 */
const HOST_BENCH_HOURS = 6;

export async function runReaper(env: Env): Promise<void> {
  // Operator kill-switch for calibration sessions: a live instance being driven
  // by hand looks exactly like every failure mode the sweeps hunt (idle, no
  // renders, unknown-to-DB) — pausing beats fighting the state machine.
  if (env.REAPER_PAUSED === '1') {
    logger.warn('reaper PAUSED via REAPER_PAUSED env — no sweeps run');
    return;
  }
  logger.info('reaper run started');

  // Sweeps 1-5, 2b, 7 run in parallel; sweep 6 (ghost alert) and sweep 8 (orphan
  // Vast instances) run after so the orphan reconciliation sees the post-sweep DB state.
  const [stuck, orphaned, provisioning, renderedStuck, queuedStuck, errorInstances, stalledChains] = await Promise.all([
    sweepStuckRenderingJobs(env),
    sweepOrphanedInstances(env),
    sweepStuckProvisioning(env),
    sweepStuckRenderedJobs(env),
    sweepStuckQueuedStreams(env),
    sweepErrorInstances(env),
    sweepStalledBatchChains(env),
  ]);
  const ghosts = await sweepGhostStreams(env);
  // Recycle stalled hosts / hard give-up. Runs after the parallel batch so it sees
  // post-sweep instance assignments (avoids racing sweep 2b on the same instance).
  const stalled = await sweepStalledStreams(env);
  // Run LAST: reconcile actual Vast instances against running streams. Running after
  // the other sweeps ensures vast_instance_id resets/destroys have already landed, so
  // this only kills true orphans.
  const orphanInstances = await sweepOrphanVastInstances(env);

  logger.info('reaper run complete', { stuck, orphaned, provisioning, renderedStuck, queuedStuck, errorInstances, stalledChains, ghosts, stalled, orphanInstances });
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
        AND s.videos_queued >= s.total_videos
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
 * so none of the other sweeps catch them.
 *
 * Covers two cases:
 *   1. Fresh stream — instance assigned but nothing ever rendered (original case).
 *   2. Recovery stream — partial render done, new instance assigned for the remainder,
 *      but that new instance is broken. The old check (videos_rendered=0) missed this.
 *
 * Check: stream has a real instance AND pending jobs (work still to do) AND
 * has been running long enough that a healthy boot would have completed.
 *
 * Idempotent: UPDATE uses a conditional WHERE clause on vast_instance_id so
 * a duplicate invocation on an already-reset row is a safe no-op.
 */
async function sweepErrorInstances(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - ERROR_INSTANCE_TIMEOUT_MIN * 60_000).toISOString();

  // Streams with a real (numeric) instance ID, pending jobs remaining,
  // and old enough that a healthy boot would have completed by now.
  const candidates = await env.DB
    .prepare(`
      SELECT s.id, s.vast_instance_id
      FROM streams s
      WHERE s.state = 'running'
        AND s.vast_instance_id IS NOT NULL
        AND s.vast_instance_id != 'pending'
        AND s.started_at < ?
        AND EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.stream_id = s.id AND j.state = 'pending'
        )
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

    // Transient API error → instance state is UNKNOWN. Never destroy on uncertainty;
    // re-check next cycle. (Previously a blip returned null and killed a healthy host.)
    if (status === 'unreachable') continue;

    // Healthy states that should not be disturbed.
    const isHealthy = status === 'running' || status === 'loading';
    if (isHealthy) continue;

    // Bad states: 'error', 'exited', 'created' (stuck), or null (instance gone).
    logger.warn('reaper: instance in error/dead state — resetting stream for retry', {
      stream_id: stream.id,
      instance_id: instanceId,
      actual_status: status ?? 'gone',
    });

    // Emit a prominent error so the operator can identify the broken machine and
    // add its machine_id to VAST_EXCLUDED_MACHINES. The machine_id is not available
    // from the instance status API response — look it up in the Vast.ai dashboard
    // using the instance_id above, then add it to wrangler.toml [vars] and redeploy.
    logger.error('reaper: CDI/GPU error on instance — ADD machine_id to VAST_EXCLUDED_MACHINES', {
      stream_id: stream.id,
      instance_id: instanceId,
      actual_status: status ?? 'gone',
      // machine_id not available here but visible in Vast.ai dashboard
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

// ── Sweep 7: stalled batch chains ────────────────────────────────────────────

/**
 * Detects running streams where the Gemini prompt-generation chain broke
 * mid-stream — i.e. videos_queued < total_videos AND no pending jobs exist.
 *
 * Root cause: a CF Queues stream-launch message exhausts all max_retries (5)
 * due to a Gemini 429/503 and goes to DLQ. The "enqueue next batch" step in
 * stream-consumer runs AFTER generatePromptBatch returns (success path only).
 * On DLQ the next batch message was never created, so seqs beyond that point
 * are permanently lost unless repaired here.
 *
 * Fix: re-enqueue a fresh batch starting from seq_start = videos_queued + 1.
 * The stream-consumer uses INSERT OR IGNORE so duplicate runs are safe.
 * On the NEXT reaper cycle, Sweep 3 will re-provision GPU if needed
 * (pending jobs now exist, vast_instance_id is NULL after /done reset).
 *
 * Idempotent: runs every 15 min. Extra re-enqueues on a still-throttled
 * Gemini will hit DLQ again — each cycle retries until Gemini recovers.
 */
async function sweepStalledBatchChains(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - BATCH_CHAIN_STALL_MIN * 60_000).toISOString();

  // Running streams that:
  //   • haven't generated all their videos yet (videos_queued < total_videos)
  //   • have no pending jobs left (GPU already finished whatever existed)
  //   • started long enough ago that normal in-flight batch processing is done
  const stalled = await env.DB
    .prepare(`
      SELECT s.id, s.user_id, s.videos_queued, s.total_videos
      FROM streams s
      WHERE s.state = 'running'
        AND s.videos_queued < s.total_videos
        AND s.started_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.stream_id = s.id AND j.state = 'pending'
        )
    `)
    .bind(cutoff)
    .all<{ id: string; user_id: number; videos_queued: number; total_videos: number }>();

  if (!stalled.results.length) return 0;

  logger.warn('reaper: stalled batch chains detected', { count: stalled.results.length });

  const batchSize = parseInt(env.PROMPT_BATCH_SIZE ?? '44', 10);
  let requeued = 0;

  for (const stream of stalled.results) {
    const seqStart = stream.videos_queued + 1;
    const remaining = stream.total_videos - stream.videos_queued;
    const nextBatchSize = Math.min(remaining, batchSize);
    // Use the approximate batch index (non-zero, non-99 to skip provisioning trigger
    // in stream-consumer — Sweep 3 handles re-provisioning once pending jobs exist).
    const batchIndex = Math.ceil(stream.videos_queued / batchSize);

    logger.warn('reaper: re-enqueuing stalled batch chain', {
      stream_id: stream.id,
      videos_queued: stream.videos_queued,
      total_videos: stream.total_videos,
      seq_start: seqStart,
      next_batch_size: nextBatchSize,
    });

    try {
      await enqueueStreamLaunch(env.STREAM_QUEUE, {
        stream_id: stream.id,
        user_id: stream.user_id,
        batch_index: batchIndex,
        batch_size: nextBatchSize,
        seq_start: seqStart,
      });
      requeued++;
    } catch (err) {
      logger.error('reaper: failed to re-enqueue stalled batch chain', {
        stream_id: stream.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return requeued;
}

// ── Sweep 9: stalled streams (recycle stuck host + hard give-up) ─────────────

/**
 * Catches two real-world failure modes that all other sweeps miss:
 *
 *   (a) "alive but dead" host — the container reaches actual_status='running' but
 *       bootstrap/worker silently died (slow/failed model download, crash). Jobs
 *       stay 'pending' (never 'rendering'), so sweeps 1/2b/8 all skip it and it
 *       bills for days producing nothing. (This is the 7-day phantom we saw.)
 *
 *   (b) no terminal give-up — a stream that can never render loops forever via
 *       sweep 3's re-provisioning; the ghost sweep only logs.
 *
 * Strategy (no DB migration — uses job timestamps + live instance age):
 *   - Candidate: any running stream that still has pending jobs.
 *   - HARD give-up: running > STREAM_HARD_LIMIT_HOURS AND incomplete AND no render
 *     in the last STALL_RECYCLE_MIN → mark 'failed', notify user, destroy instance.
 *     This is INSTANCE-INDEPENDENT: it must fire even when sweep 2b has already
 *     nulled the dead instance (otherwise a perpetually re-provisioning stream
 *     would never be given up on). A progressing stream is never force-failed.
 *   - RECYCLE: a still-assigned instance up > STALL_RECYCLE_MIN with no render
 *     progress → destroy + reset to NULL so sweep 3 re-provisions on a fresh host.
 *     The live instance-age check protects a still-booting replacement.
 */
/**
 * Per-mode "no render progress yet" recycle window, minutes.
 *
 * Flex: ghcr image pull ~4.5 min + 55 GB weights ~16 min → first render ~22 min;
 * 40 gives ~2× headroom. Max: the 42 GB dev checkpoint may fall back to
 * HuggingFace until R2 is seeded, and a max render itself runs many minutes —
 * with a 40-min window the reaper would destroy a legitimately-downloading first
 * boot AND false-bench a healthy host from the small RTX PRO 6000 pool, looping
 * until the 24 h give-up. 90 covers HF-fallback boot + first long render.
 * Max2 gets the same 90: its first boot pulls ~38 GB of Wan 2.2 weights,
 * possibly all from HuggingFace until R2 is seeded.
 */
function stallRecycleMin(mode: string | null): number {
  return mode === 'max' || mode === 'max2' ? 90 : STALL_RECYCLE_MIN;  // max2 = legacy rows
}

async function sweepStalledStreams(env: Env): Promise<number> {
  const now = Date.now();
  const hardCutoff = new Date(now - STREAM_HARD_LIMIT_HOURS * 3_600_000).toISOString();

  const candidates = await env.DB
    .prepare(`
      SELECT s.id, s.user_id, s.vast_instance_id, s.vast_host_id, s.vast_host_ip, s.started_at,
             s.quality_mode,
             s.total_videos, s.videos_rendered,
             (SELECT MAX(j2.render_completed_at) FROM jobs j2 WHERE j2.stream_id = s.id) AS last_render,
             (SELECT MAX(j3.render_started_at)   FROM jobs j3 WHERE j3.stream_id = s.id) AS last_start
      FROM streams s
      WHERE s.state = 'running'
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.stream_id = s.id AND j.state = 'pending')
    `)
    .all<{
      id: string; user_id: number; vast_instance_id: string | null; vast_host_id: number | null;
      vast_host_ip: string | null;
      started_at: string | null; quality_mode: string | null;
      total_videos: number; videos_rendered: number;
      last_render: string | null; last_start: string | null;
    }>();

  if (!candidates.results.length) return 0;

  const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
  let acted = 0;

  for (const s of candidates.results) {
    // Instance may be a real id, 'pending', or NULL (sweep 2b/3 mid-cycle).
    const instanceId = s.vast_instance_id && s.vast_instance_id !== 'pending'
      ? parseInt(s.vast_instance_id, 10) : NaN;
    const hasInstance = !isNaN(instanceId);

    // Most recent render activity (claim or completion). null → never rendered.
    const recycleMin = stallRecycleMin(s.quality_mode);
    const recycleCutoff = new Date(now - recycleMin * 60_000).toISOString();
    const lastActivity = [s.last_render, s.last_start].filter(Boolean).sort().at(-1) ?? null;
    const noRecentProgress = !lastActivity || lastActivity < recycleCutoff;

    // ── HARD give-up: old, incomplete, not progressing — fires regardless of
    //    instance state so a re-provisioning loop is eventually stopped. ────────
    if (
      s.started_at && s.started_at < hardCutoff &&
      s.videos_rendered < s.total_videos &&
      noRecentProgress
    ) {
      logger.error('reaper: stream hard give-up — failing after limit', {
        stream_id: s.id, started_at: s.started_at,
        rendered: s.videos_rendered, total: s.total_videos,
      });
      await env.DB
        .prepare(`UPDATE streams SET state='failed', completed_at=? WHERE id=? AND state='running'`)
        .bind(nowIso(), s.id)
        .run();
      if (hasInstance) { try { await vast.destroyInstance(instanceId); } catch { /* may be gone */ } }
      await notifyUser(env, s.user_id,
        `⚠️ Stream stopped: no render progress after ${STREAM_HARD_LIMIT_HOURS}h. ` +
        `${s.videos_rendered}/${s.total_videos} videos were published. ` +
        `You can start a new stream to retry the rest.`);
      acted++;
      continue;
    }

    if (!noRecentProgress) continue;  // actively rendering — leave it alone
    if (!hasInstance) continue;        // no live instance to recycle (sweep 3 provisions)

    // ── RECYCLE: only if the instance itself has been up long enough ──────────
    // (protects a freshly re-provisioned replacement that is still booting).
    let instanceAgeMin = Infinity;
    let actualStatus = '';
    try {
      const inst = await vast.getInstance(instanceId);
      if (inst.start_date) instanceAgeMin = (now / 1000 - inst.start_date) / 60;
      actualStatus = inst.actual_status ?? '';
    } catch {
      // Instance not found / unreachable — let sweep 2b/8 handle it, skip here.
      continue;
    }

    // Two recycle triggers:
    //   • STUCK LOADING — never reached 'running' (e.g. "Secrets fetch failed",
    //     stuck Docker pull). Caught at LOADING_STUCK_MIN (~20m), well before the
    //     slower alive-but-dead threshold.
    //   • ALIVE BUT DEAD — reached 'running' but no render progress for 40m+.
    const loadingStuckMin = minutesFromEnv(env.REAPER_LOADING_STUCK_MIN, LOADING_STUCK_MIN);
    const stuckLoading = (actualStatus === 'loading' || actualStatus === 'created')
      && instanceAgeMin >= loadingStuckMin;
    const aliveButDead = actualStatus === 'running' && instanceAgeMin >= recycleMin;
    if (!stuckLoading && !aliveButDead) continue; // still booting / progressing — protect

    const reason = stuckLoading ? 'stuck-loading' : 'alive-but-dead';
    logger.error('reaper: stalled host — recycling instance', {
      stream_id: s.id, instance_id: instanceId, host_id: s.vast_host_id, actual_status: actualStatus,
      reason,
      instance_age_min: Math.round(instanceAgeMin), last_activity: lastActivity ?? 'never',
    });
    try { await vast.destroyInstance(instanceId); } catch { /* may be gone */ }

    // Bench the host BEFORE clearing the instance, so the re-provision below cannot
    // race back onto it. Without this the next search — deterministic `dph_total asc`
    // — hands back the same cheapest broken host and the stream loops forever.
    if (s.vast_host_id) {
      try {
        await env.DB
          .prepare(`INSERT INTO host_failures (host_id, host_ip, reason, stream_id, failed_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(s.vast_host_id, s.vast_host_ip, reason, s.id, nowIso())
          .run();
        logger.info('reaper: host benched', {
          host_id: s.vast_host_id, host_ip: s.vast_host_ip, reason, cooldown_hours: HOST_BENCH_HOURS,
        });
      } catch (err) {
        logger.warn('reaper: could not bench host', {
          host_id: s.vast_host_id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await env.DB
      .prepare(`UPDATE streams SET vast_instance_id=NULL, vast_host_id=NULL, vast_host_ip=NULL WHERE id=? AND vast_instance_id=?`)
      .bind(s.id, s.vast_instance_id)
      .run();

    // Re-provision immediately instead of waiting for sweep 3 on the next cron tick.
    // Sweep 3 runs earlier in runReaper()'s Promise.all, so it has already passed by
    // the time we null the instance here — leaving the stream idle for a full 15-min
    // cron interval on top of the detection delay.
    try {
      await enqueueStreamLaunch(env.STREAM_QUEUE, {
        stream_id: s.id,
        user_id: s.user_id,
        batch_index: 99,  // sentinel: provision-only, skip prompt gen
        batch_size: 0,
        seq_start: 0,
      });
      logger.info('reaper: re-enqueued provisioning after recycle', { stream_id: s.id });
    } catch (err) {
      logger.error('reaper: re-enqueue after recycle failed — sweep 3 will retry', {
        stream_id: s.id, error: err instanceof Error ? err.message : String(err),
      });
    }
    acted++;
  }

  return acted;
}

/** Best-effort Telegram DM to the operator (never throws into the reaper). */
async function notifyUser(env: Env, userId: number, text: string): Promise<void> {
  try {
    await telegramCall('sendMessage', { chat_id: userId, text }, env.CONTROL_BOT_TOKEN);
  } catch (err) {
    logger.warn('reaper: user notify failed', {
      user_id: userId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Sweep 8: orphan Vast instances (money-leak safety net) ───────────────────

/**
 * Destroys any Vast instance that is billing but not tied to a running stream.
 *
 * The "protected" set is the numeric vast_instance_id of every stream currently
 * in 'running' state. Any owned instance NOT in that set — and older than the
 * provisioning grace window — is an orphan and is destroyed.
 *
 * Why this is needed: the per-stream destroy paths (provision-failed, /done,
 * sweep 2/2b) can all miss an instance if its id is unknown (worker reported 0)
 * or if vast_instance_id was overwritten by a re-provision before the old
 * instance was killed. This sweep closes every gap by reconciling the actual
 * Vast.ai instance list against the DB, so no instance can bill indefinitely.
 *
 * Safety: instances younger than ORPHAN_INSTANCE_GRACE_MIN are never touched,
 * protecting the brief window between startInstance() and the DB id write.
 */
async function sweepOrphanVastInstances(env: Env): Promise<number> {
  const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
  const instances = await vast.listInstances();
  if (!instances.length) return 0;

  // Protected set: instance ids of all currently-running streams.
  const runningRows = await env.DB
    .prepare(`
      SELECT vast_instance_id FROM streams
      WHERE state = 'running'
        AND vast_instance_id IS NOT NULL
        AND vast_instance_id != 'pending'
    `)
    .all<{ vast_instance_id: string }>();

  const protectedIds = new Set<number>();
  for (const r of runningRows.results) {
    const id = parseInt(r.vast_instance_id, 10);
    if (!isNaN(id)) protectedIds.add(id);
  }

  const graceCutoffSecs = Math.floor(Date.now() / 1000) - ORPHAN_INSTANCE_GRACE_MIN * 60;
  let destroyed = 0;

  for (const inst of instances) {
    if (protectedIds.has(inst.id)) continue;

    // Protect freshly-created instances (provisioning race window). When start_date
    // is missing, treat as old enough to act on — a long-lived instance with no
    // start_date is still a leak.
    const startSecs = inst.start_date ?? 0;
    if (startSecs > graceCutoffSecs) {
      logger.info('orphan sweep: skipping young unmatched instance (grace window)', {
        instance_id: inst.id,
        label: inst.label,
        age_secs: startSecs ? Math.floor(Date.now() / 1000) - startSecs : null,
      });
      continue;
    }

    logger.error('orphan sweep: destroying orphan Vast instance (not tied to any running stream)', {
      instance_id: inst.id,
      label: inst.label,
      actual_status: inst.actual_status,
      dph_total: inst.dph_total,
    });

    try {
      await vast.destroyInstance(inst.id);
      destroyed++;
    } catch (err) {
      logger.warn('orphan sweep: destroy failed (may already be gone)', {
        instance_id: inst.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return destroyed;
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
