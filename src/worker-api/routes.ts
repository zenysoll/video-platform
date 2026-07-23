/**
 * Worker API routes — called by GPU workers over HTTPS.
 *
 * All routes require Authorization: Bearer {WORKER_SECRET}.
 *
 * Routes:
 *   GET  /worker/jobs/claim?stream_id=&instance_id=   — claim next pending job
 *   POST /worker/jobs/:id/complete                     — mark rendered, enqueue publish
 *   POST /worker/jobs/:id/fail                         — record failure
 *   POST /worker/videos/:id                            — upload video bytes (stored in R2)
 *   POST /worker/streams/:id/done                      — all jobs done, destroy instance
 *   POST /worker/streams/:id/provision-failed          — GPU init failed, destroy instance, reset for reaper retry
 */

import type { Env } from '../config/env.js';
import { enqueuePublishJob } from '../queues/publish-producer.js';
import { VastClient } from '../vast/client.js';
import { R2Client } from '../r2/client.js';
import { buildR2Key } from '../r2/naming.js';
import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/idempotency.js';

export async function handleWorkerRequest(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const method = request.method;

  // GET /worker/jobs/claim
  if (method === 'GET' && path === '/worker/jobs/claim') {
    return handleJobClaim(request, env);
  }

  // POST /worker/videos/:id
  const videoMatch = path.match(/^\/worker\/videos\/([^/]+)$/);
  if (method === 'POST' && videoMatch) {
    return handleVideoUpload(request, env, videoMatch[1]!);
  }

  // POST /worker/jobs/:id/complete
  const completeMatch = path.match(/^\/worker\/jobs\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    return handleJobComplete(request, env, completeMatch[1]!);
  }

  // POST /worker/jobs/:id/fail
  const failMatch = path.match(/^\/worker\/jobs\/([^/]+)\/fail$/);
  if (method === 'POST' && failMatch) {
    return handleJobFail(request, env, failMatch[1]!);
  }

  // POST /worker/streams/:id/done
  const doneMatch = path.match(/^\/worker\/streams\/([^/]+)\/done$/);
  if (method === 'POST' && doneMatch) {
    return handleStreamDone(request, env, doneMatch[1]!);
  }

  // POST /worker/streams/:id/provision-failed
  const provisionFailedMatch = path.match(/^\/worker\/streams\/([^/]+)\/provision-failed$/);
  if (method === 'POST' && provisionFailedMatch) {
    return handleProvisionFailed(request, env, provisionFailedMatch[1]!);
  }

  return new Response('Not Found', { status: 404 });
}

// ── Claim next pending job ────────────────────────────────────────────────────

async function handleJobClaim(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const streamId = url.searchParams.get('stream_id');
  const instanceId = url.searchParams.get('instance_id');

  if (!streamId) {
    return Response.json({ error: 'stream_id required' }, { status: 400 });
  }

  // Load stream to get video params.
  const stream = await env.DB
    .prepare('SELECT * FROM streams WHERE id = ?')
    .bind(streamId)
    .first<{
      id: string; state: string; total_videos: number;
      width: number | null; height: number | null;
      fps: number; duration_secs: number; sound_enabled: number;
      bucket_id: string;
    }>();

  if (!stream) {
    return Response.json({ error: 'stream not found' }, { status: 404 });
  }

  // Claim next pending job ATOMICALLY in a single statement.
  // The previous SELECT-then-UPDATE was a check-then-act race: with multiple GPU
  // workers (2×/4×) two could SELECT the same pending row and both render it. Here
  // the UPDATE selects the next pending row in a subquery and flips it in one write;
  // SQLite serialises writes, so concurrent claims each get a DISTINCT row (the
  // second statement's subquery re-evaluates after the first commits). RETURNING
  // gives us the claimed row only if this worker actually won it.
  const job = await env.DB
    .prepare(`
      UPDATE jobs
      SET state = 'rendering',
          vast_instance_id = ?,
          render_started_at = ?,
          render_attempts = render_attempts + 1
      WHERE id = (
        SELECT id FROM jobs
        WHERE stream_id = ? AND state = 'pending'
        ORDER BY sequence_num ASC LIMIT 1
      ) AND state = 'pending'
      RETURNING id, prompt_text, sequence_num
    `)
    .bind(instanceId ?? null, nowIso(), streamId)
    .first<{ id: string; prompt_text: string; sequence_num: number }>();

  if (!job) {
    // No more pending jobs (or another worker just took the last one).
    return new Response(null, { status: 204 });
  }

  logger.info('job claimed', {
    job_id: job.id,
    stream_id: streamId,
    sequence_num: job.sequence_num,
    instance_id: instanceId,
  });

  return Response.json({
    job_id: job.id,
    stream_id: streamId,
    sequence_num: job.sequence_num,
    prompt_text: job.prompt_text,
    // r2_key is NOT returned at claim time — it is determined at upload time
    // (POST /worker/videos/:id) and echoed back in that response.
    width: stream.width ?? 768,
    height: stream.height ?? 512,
    fps: stream.fps,
    duration_secs: stream.duration_secs,
    sound_enabled: stream.sound_enabled === 1,
  });
}

// ── Upload video bytes ────────────────────────────────────────────────────────

async function handleVideoUpload(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  // Load job + stream metadata in one joined query to build the flat R2 key.
  const row = await env.DB
    .prepare(`
      SELECT j.id, j.stream_id,
             s.width, s.height, s.fps, s.duration_secs, s.bucket_id, s.quality_mode
      FROM jobs j
      JOIN streams s ON s.id = j.stream_id
      WHERE j.id = ?
    `)
    .bind(jobId)
    .first<{
      id: string; stream_id: string;
      width: number | null; height: number | null;
      fps: number; duration_secs: number;
      bucket_id: string | null; quality_mode: string | null;
    }>();

  if (!row) return Response.json({ error: 'job not found' }, { status: 404 });

  // Build flat key at upload time — timestamp is the upload moment.
  const r2Key = buildR2Key({
    jobId,
    width: row.width ?? 768,
    height: row.height ?? 512,
    fps: row.fps,
    durationSecs: row.duration_secs,
    // 'max2' is the legacy value of the Wan tier — tag it _max like any other.
    mode: (row.quality_mode === 'max' || row.quality_mode === 'max2') ? 'max' : 'flex',
  });

  const contentType = request.headers.get('Content-Type') ?? 'video/mp4';

  // Buffer the body once — ReadableStream can only be consumed once.
  const videoBytes = await request.arrayBuffer();

  // Always write to R2_ADMIN (publish-consumer reads from here).
  await env.R2_ADMIN.put(r2Key, videoBytes, {
    httpMetadata: { contentType },
  });

  // Also write to the operator's bucket if the stream has one.
  const bucket = row.bucket_id
    ? await env.DB
        .prepare('SELECT bucket_name FROM buckets WHERE id = ?')
        .bind(row.bucket_id)
        .first<{ bucket_name: string }>()
    : null;

  const operatorBucket = bucket?.bucket_name;
  if (operatorBucket && operatorBucket !== 'video-platform-admin') {
    try {
      const r2Rest = R2Client.forBucket(operatorBucket, env.R2_ACCOUNT_ID, env.R2_ACCOUNT_TOKEN);
      await r2Rest.put(r2Key, videoBytes, contentType);
      logger.info('video uploaded to operator bucket', { job_id: jobId, bucket: operatorBucket });
    } catch (err) {
      // Non-fatal: video is already in R2_ADMIN so publish will succeed.
      logger.error('operator bucket upload failed', {
        job_id: jobId,
        bucket: operatorBucket,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('video uploaded', { job_id: jobId, r2_key: r2Key });
  return Response.json({ ok: true, r2_key: r2Key });
}

// ── Complete job ──────────────────────────────────────────────────────────────

async function handleJobComplete(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const body = await request.json() as { r2_key?: string; r2_bucket?: string };
  const r2Key = body.r2_key;

  if (!r2Key) return Response.json({ error: 'r2_key required' }, { status: 400 });

  // Idempotency: skip if already past 'rendering'.
  const job = await env.DB
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<{
      id: string; stream_id: string; user_id: number; state: string;
      prompt_text: string | null; render_attempts: number;
    }>();

  if (!job) return Response.json({ error: 'not found' }, { status: 404 });
  if (job.state !== 'rendering') {
    return Response.json({ ok: true, skipped: true });
  }

  const now = nowIso();

  // Get stream's bucket + channel.
  const stream = await env.DB
    .prepare('SELECT bucket_id, channel_id FROM streams WHERE id = ?')
    .bind(job.stream_id)
    .first<{ bucket_id: string; channel_id: string | null }>();

  const bucket = stream?.bucket_id
    ? await env.DB
        .prepare('SELECT bucket_name FROM buckets WHERE id = ?')
        .bind(stream.bucket_id)
        .first<{ bucket_name: string }>()
    : null;

  // Transition job to 'rendered'.
  await env.DB
    .prepare(`
      UPDATE jobs
      SET state = 'rendered', r2_key = ?, r2_bucket = ?, render_completed_at = ?
      WHERE id = ?
    `)
    .bind(r2Key, bucket?.bucket_name ?? 'video-platform-admin', now, jobId)
    .run();

  // Atomic counter update on stream.
  await env.DB
    .prepare('UPDATE streams SET videos_rendered = videos_rendered + 1 WHERE id = ?')
    .bind(job.stream_id)
    .run();

  logger.info('job rendered', { job_id: jobId, stream_id: job.stream_id, r2_key: r2Key });

  // Enqueue for publishing.
  if (job.prompt_text && stream?.channel_id) {
    await enqueuePublishJob(env.PUBLISH_QUEUE, {
      job_id: jobId,
      stream_id: job.stream_id,
      channel_id: stream.channel_id,
      r2_key: r2Key,
      r2_bucket: bucket?.bucket_name ?? 'video-platform-admin',
      prompt_text: job.prompt_text,
    });
  }

  return Response.json({ ok: true });
}

// ── Fail job ──────────────────────────────────────────────────────────────────

async function handleJobFail(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const body = await request.json() as { error?: string };
  const errorMsg = (body.error ?? 'unknown error').slice(0, 2000);

  const job = await env.DB
    .prepare('SELECT id, stream_id, render_attempts, max_attempts, state FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<{
      id: string; stream_id: string;
      render_attempts: number; max_attempts: number; state: string;
    }>();

  if (!job || job.state !== 'rendering') {
    return Response.json({ ok: true, skipped: true });
  }

  const isTerminal = job.render_attempts >= job.max_attempts;
  const newState = isTerminal ? 'failed' : 'pending';
  const now = nowIso();

  await env.DB
    .prepare(`
      UPDATE jobs SET state = ?, error_message = ?, failed_at = ? WHERE id = ?
    `)
    .bind(newState, errorMsg, isTerminal ? now : null, jobId)
    .run();

  if (isTerminal) {
    await env.DB
      .prepare('UPDATE streams SET videos_failed = videos_failed + 1 WHERE id = ?')
      .bind(job.stream_id)
      .run();
  }

  logger.warn('job failed', {
    job_id: jobId,
    stream_id: job.stream_id,
    terminal: isTerminal,
    attempts: job.render_attempts,
    error: errorMsg,
  });

  return Response.json({ ok: true, terminal: isTerminal });
}

// ── Stream done — destroy Vast instance ──────────────────────────────────────

async function handleStreamDone(
  request: Request,
  env: Env,
  streamId: string,
): Promise<Response> {
  const body = await request.json() as { instance_id?: number };
  const instanceId = body.instance_id;

  logger.info('stream done signal received', { stream_id: streamId, instance_id: instanceId });

  const now = nowIso();

  // Capture the authoritative instance id from D1 BEFORE the more-work path resets
  // it to NULL. The worker-reported instance_id can be 0 (missing container env),
  // so relying on it alone leaks orphan instances that keep billing.
  const doneStreamRow = await env.DB
    .prepare(`SELECT vast_instance_id FROM streams WHERE id = ?`)
    .bind(streamId)
    .first<{ vast_instance_id: string | null }>();
  const doneDbInstanceId =
    doneStreamRow?.vast_instance_id && doneStreamRow.vast_instance_id !== 'pending'
      ? parseInt(doneStreamRow.vast_instance_id, 10)
      : NaN;

  // Worker sends /done after exhausting all pending jobs — it is the authoritative signal.
  // Any jobs still in 'rendering' at this point belong to a crashed worker iteration;
  // fail them so the stream can close cleanly rather than hanging for 25+ min until reaper.
  //
  // Multi-GPU: scope to THIS instance's jobs only. Without the scope, a /done from
  // one GPU worker would fail jobs that OTHER GPU workers on the same stream are
  // still actively rendering. When instance_id is absent (legacy single-GPU), fall
  // back to failing all rendering jobs (there is only one worker anyway).
  const scopeInstance = typeof instanceId === 'number' && instanceId > 0;
  const failResult = await env.DB
    .prepare(
      scopeInstance
        ? `UPDATE jobs SET state='failed',
             error_message='Instance terminated — worker exited before completion', failed_at=?
           WHERE stream_id=? AND state='rendering' AND vast_instance_id=?`
        : `UPDATE jobs SET state='failed',
             error_message='Instance terminated — worker exited before completion', failed_at=?
           WHERE stream_id=? AND state='rendering'`
    )
    .bind(...(scopeInstance ? [now, streamId, String(instanceId)] : [now, streamId]))
    .run();

  const failedNow = (failResult as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (failedNow > 0) {
    await env.DB
      .prepare('UPDATE streams SET videos_failed = videos_failed + ? WHERE id = ?')
      .bind(failedNow, streamId)
      .run();
    logger.warn('stream done: failed stuck rendering jobs', { stream_id: streamId, count: failedNow });
  }

  // Determine if the stream is truly finished or if there are more jobs to process.
  //
  // Two cases where we must NOT mark completed:
  //   1. Pending jobs exist in DB — new prompts arrived after the worker's last poll.
  //   2. total_jobs_in_db < total_videos — Gemini is still generating prompts;
  //      the GPU finished the current batch faster than prompts were created.
  //      When /done arrives, pending=0 but 607 more jobs haven't been inserted yet.
  const [pendingCheck, jobCountCheck, streamRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS cnt FROM jobs WHERE stream_id = ? AND state = 'pending'`)
      .bind(streamId).first<{ cnt: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS cnt FROM jobs WHERE stream_id = ?`)
      .bind(streamId).first<{ cnt: number }>(),
    env.DB.prepare(`SELECT total_videos FROM streams WHERE id = ?`)
      .bind(streamId).first<{ total_videos: number }>(),
  ]);

  const pendingCount = pendingCheck?.cnt ?? 0;
  const totalJobsCreated = jobCountCheck?.cnt ?? 0;
  const totalVideos = streamRow?.total_videos ?? 0;
  const allPromptsGenerated = totalJobsCreated >= totalVideos;

  if (pendingCount > 0 || !allPromptsGenerated) {
    // More work remains — reset instance so reaper triggers re-provisioning.
    await env.DB
      .prepare(`UPDATE streams SET vast_instance_id = NULL WHERE id = ? AND state = 'running'`)
      .bind(streamId)
      .run();
    logger.info('stream done: more work remains, resetting for re-provision', {
      stream_id: streamId,
      pending_count: pendingCount,
      total_jobs_created: totalJobsCreated,
      total_videos: totalVideos,
      all_prompts_generated: allPromptsGenerated,
    });
  } else {
    // Truly finished — all prompts generated and all jobs rendered.
    await env.DB
      .prepare(`UPDATE streams SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'running'`)
      .bind(now, streamId)
      .run();
    logger.info('stream marked completed', { stream_id: streamId });
  }

  // Destroy Vast instance regardless (worker is exiting either way).
  // Destroy both the DB-authoritative id and the worker-reported id (deduped) so a
  // missing/0 worker id can never leave an instance billing.
  const doneToDestroy = new Set<number>();
  if (!isNaN(doneDbInstanceId) && doneDbInstanceId > 0) doneToDestroy.add(doneDbInstanceId);
  if (typeof instanceId === 'number' && instanceId > 0) doneToDestroy.add(instanceId);

  if (doneToDestroy.size > 0) {
    const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
    for (const id of doneToDestroy) {
      try {
        await vast.destroyInstance(id);
        logger.info('vast instance destroyed', { instance_id: id, stream_id: streamId });
      } catch (err) {
        logger.error('failed to destroy vast instance', {
          instance_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't fail the response — instance may already be gone.
      }
    }
  }

  return Response.json({ ok: true });
}

// ── Provision failed — reset stream for reaper retry ─────────────────────────

async function handleProvisionFailed(
  request: Request,
  env: Env,
  streamId: string,
): Promise<Response> {
  const body = await request.json() as { instance_id?: number; reason?: string };
  const instanceId = body.instance_id;
  const reason = (body.reason ?? 'unknown').slice(0, 200);

  logger.warn('provision-failed signal received', {
    stream_id: streamId,
    instance_id: instanceId,
    reason,
  });

  // The worker-reported instance_id is unreliable: bootstrap.sh derives it from
  // the container env, which can be missing → 0. A 0 here previously meant the
  // broken instance was NEVER destroyed (the `if (instanceId)` guard was false),
  // so it kept billing while the reaper provisioned a replacement — every failed
  // boot leaked one orphan instance. The authoritative source is the stream's
  // vast_instance_id in D1 (set by runProvisioning). Read it BEFORE resetting to
  // 'pending', then destroy BOTH the DB id and the reported id.
  const streamRow = await env.DB
    .prepare(`SELECT vast_instance_id FROM streams WHERE id = ?`)
    .bind(streamId)
    .first<{ vast_instance_id: string | null }>();
  const dbInstanceId =
    streamRow?.vast_instance_id && streamRow.vast_instance_id !== 'pending'
      ? parseInt(streamRow.vast_instance_id, 10)
      : NaN;

  // Reset to 'pending' — reaper will re-provision on next tick (5+ min).
  // Do NOT mark stream completed: all jobs are still pending, stream should retry.
  await env.DB
    .prepare(`UPDATE streams SET vast_instance_id = 'pending' WHERE id = ? AND state = 'running'`)
    .bind(streamId)
    .run();

  // Destroy every candidate instance id (DB + worker-reported), deduped, to stop billing.
  const toDestroy = new Set<number>();
  if (!isNaN(dbInstanceId) && dbInstanceId > 0) toDestroy.add(dbInstanceId);
  if (typeof instanceId === 'number' && instanceId > 0) toDestroy.add(instanceId);

  if (toDestroy.size > 0) {
    const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
    for (const id of toDestroy) {
      try {
        await vast.destroyInstance(id);
        logger.info('provision-failed: broken instance destroyed', { instance_id: id });
      } catch (err) {
        logger.warn('provision-failed: destroy failed (may already be gone)', {
          instance_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    logger.error('provision-failed: no instance id to destroy — orphan reaper will catch it', {
      stream_id: streamId,
    });
  }

  return Response.json({ ok: true });
}
