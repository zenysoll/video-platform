/**
 * Stream launch queue consumer.
 *
 * Processes one stream launch message per invocation (batch size = 1).
 *
 * For each message:
 * 1. Load stream from D1 — verify state is 'queued' or 'running'.
 * 2. Generate a batch of prompts via the Gemini pipeline.
 * 3. Create job records in D1.
 * 4. Save prompt fingerprints.
 * 5. Enqueue render jobs to render-queue.
 * 6. If more batches remain, enqueue next batch to stream-queue.
 * 7. Transition stream to 'running' on first batch.
 *
 * Idempotency: jobs have UNIQUE (stream_id, sequence_num).
 * Duplicate messages will fail silently on INSERT and ack cleanly.
 */

import type { Env } from '../config/env.js';
import type { StreamLaunchMessage } from './stream-producer.js';
import { enqueueStreamLaunch } from './stream-producer.js';
import { enqueueRenderJob } from './render-producer.js';
import { generatePromptBatch, persistPromptFingerprints } from '../prompts/pipeline.js';
import { buildPriorAvoidLabelsForStream } from '../prompts/fingerprint.js';
import { VastClient } from '../vast/client.js';
import { generateId, nowIso } from '../lib/idempotency.js';
import { logger } from '../lib/logger.js';

const STREAM_CONTEXT = 'short-form social video, dynamic and engaging, suitable for any audience';

/** Prior fingerprint rows (rich brief labels) for planner avoid-list. */
const PRIOR_BRIEF_AVOID_LIMIT = 85;
/** Prior final prompt excerpts — catch same plot, different wording. */
const PRIOR_PROMPT_SNIPPET_LIMIT = 18;

// GPU requirements for LTX-2.3 (22B model, 46.1 GB on disk, ~30 GB VRAM at runtime)
const GPU_MIN_VRAM_GB = 30;          // RTX 5090 = 32 GB; 30 gives safety margin vs off-by-one floats
const GPU_MIN_RAM_GB = 48;           // system RAM — use 48 so cheapest RTX 5090 (cpu_ram≈64 GB reported as ~64009 MB) passes the filter
const GPU_MIN_DISK_GB = 120;         // 46 GB model + 9 GB Gemma + ComfyUI + workspace buffer (reduced from 200 — image pre-installs ComfyUI)
const GPU_MIN_RELIABILITY = 0.98;   // reliability2 score 0–1. 0.98+ filters out worst hosts while keeping cheap US supply
const GPU_MIN_INET_DOWN = 500;       // 500 Mbps ≈ 60 MB/s — ensures 46 GB model loads in <15 min; filters slow/Chinese datacenter instances
const GPU_PREFERRED = 'RTX 5090';   // Vast.ai uses spaces in GPU names

// Pre-built image with PyTorch nightly cu128, ComfyUI + LTXVideo + VideoHelperSuite.
// Cold-start: ~5-7 min (R2 model download) vs ~20 min (full bootstrap from scratch).
// Build: docker build -t YOUR_DOCKERHUB/comfyui-ltx:cu128 . && docker push ...
// After pushing, replace the tag below with your Docker Hub image.
const WORKER_IMAGE = 'pytorch/pytorch:2.6.0-cuda12.6-cudnn9-runtime'; // TODO: replace with pre-built image after push

export async function handleStreamBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body as Partial<StreamLaunchMessage>;

    if (body.version !== 1 || !body.stream_id) {
      logger.warn('stream-queue unknown message', { id: msg.id });
      msg.ack();
      continue;
    }

    try {
      await processStreamBatch(body as StreamLaunchMessage, env);
      msg.ack();
    } catch (err) {
      logger.error('stream batch processing failed', {
        stream_id: body.stream_id,
        batch_index: body.batch_index,
        error: err instanceof Error ? err.message : String(err),
      });
      // Retry — do NOT ack. CF Queues will retry up to max_retries.
      msg.retry();
    }
  }
}

async function processStreamBatch(msg: StreamLaunchMessage, env: Env): Promise<void> {
  const { stream_id, user_id, batch_index, batch_size, seq_start } = msg;

  // Load stream to get video parameters.
  const stream = await env.DB
    .prepare('SELECT * FROM streams WHERE id = ?')
    .bind(stream_id)
    .first<{
      id: string; state: string; total_videos: number;
      duration_secs: number; videos_queued: number;
      name: string; gpu_count: number;
    }>();

  if (!stream) {
    logger.error('stream not found', { stream_id });
    return;
  }

  if (stream.state === 'completed' || stream.state === 'cancelled') {
    logger.info('stream already finished, skipping batch', { stream_id, state: stream.state });
    return;
  }

  // Provision-only sentinel: reaper re-enqueues with batch_index=99 when provisioning is stuck.
  // Skip prompt generation and go straight to provisioning.
  if (batch_index === 99) {
    logger.info('provision-only message (from reaper), skipping prompt gen', { stream_id });
    await provisionVastInstance(stream_id, stream, env);
    return;
  }

  logger.info('processing stream batch', {
    stream_id,
    batch_index,
    batch_size,
    seq_start,
    stream_state: stream.state,
  });

  // Generate prompts.
  const geminiConfig = {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  };

  const priorAvoidLabels = await buildPriorAvoidLabelsForStream(
    env.DB,
    stream_id,
    PRIOR_BRIEF_AVOID_LIMIT,
    PRIOR_PROMPT_SNIPPET_LIMIT,
  );

  const prompts = await generatePromptBatch(
    batch_size,
    stream.duration_secs,
    STREAM_CONTEXT,
    env.DB,
    geminiConfig,
    priorAvoidLabels,
    {
      streamId: stream_id,
      batchIndex: batch_index,
      seqStart: seq_start,
      diversityMode: env.DIVERSITY_MODE ?? 'soft',
    },
  );

  if (prompts.length === 0) {
    logger.warn('no prompts generated for batch — throwing to trigger queue retry', { stream_id, batch_index });
    throw new Error('generatePromptBatch returned 0 prompts (Gemini unavailable) — CF Queues will retry');
  }

  // Create job records in D1.
  const now = nowIso();
  const jobIds: string[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i]!;
    const seqNum = seq_start + i;
    const jobId = generateId();
    jobIds.push(jobId);

    await env.DB
      .prepare(`
        INSERT OR IGNORE INTO jobs
          (id, stream_id, user_id, sequence_num, state, prompt_text, prompt_fingerprint, created_at,
           render_attempts, publish_attempts, max_attempts)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0, 0, 3)
      `)
      .bind(jobId, stream_id, user_id, seqNum, p.promptText, p.fingerprint, now)
      .run();
  }

  // Persist fingerprints.
  await persistPromptFingerprints(env.DB, prompts, stream_id, jobIds);

  // Update stream counters + transition to 'running' BEFORE external calls.
  // This is the critical state machine step — must succeed even if queue sends fail.
  const newQueued = stream.videos_queued + prompts.length;
  if (batch_index === 0) {
    await env.DB
      .prepare(`
        UPDATE streams
        SET state = 'running', videos_queued = ?, started_at = ?
        WHERE id = ? AND state = 'queued'
      `)
      .bind(newQueued, now, stream_id)
      .run();
    // Already running (idempotent retry) — just bump counter.
    await env.DB
      .prepare(`
        UPDATE streams SET videos_queued = ? WHERE id = ? AND state = 'running' AND videos_queued < ?
      `)
      .bind(newQueued, stream_id, newQueued)
      .run();
  } else {
    await env.DB
      .prepare('UPDATE streams SET videos_queued = ? WHERE id = ?')
      .bind(newQueued, stream_id)
      .run();
  }

  logger.info('batch complete', {
    stream_id,
    batch_index,
    jobs_created: jobIds.length,
    videos_queued: newQueued,
  });

  // Enqueue render jobs — best-effort (GPU worker polls /worker/jobs/claim directly).
  // A failed enqueue is not fatal; the worker will still pick up pending jobs.
  for (let i = 0; i < jobIds.length; i++) {
    const jobId = jobIds[i]!;
    const seqNum = seq_start + i;
    try {
      await enqueueRenderJob(env.RENDER_QUEUE, {
        job_id: jobId,
        stream_id,
        sequence_num: seqNum,
      });
    } catch (err) {
      logger.warn('render enqueue failed (non-fatal, worker will poll)', {
        job_id: jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Provision Vast instance on first batch (only once per stream).
  if (batch_index === 0) {
    await provisionVastInstance(stream_id, stream, env);
  }

  // Enqueue next batch if more videos remain.
  const nextSeqStart = seq_start + prompts.length;
  const remaining = stream.total_videos - newQueued;

  if (remaining > 0) {
    const nextBatchSize = Math.min(
      remaining,
      parseInt(env.PROMPT_BATCH_SIZE ?? '20', 10),
    );
    await enqueueStreamLaunch(env.STREAM_QUEUE, {
      stream_id,
      user_id,
      batch_index: batch_index + 1,
      batch_size: nextBatchSize,
      seq_start: nextSeqStart,
    });
    logger.info('next batch enqueued', {
      stream_id,
      next_batch: batch_index + 1,
      remaining,
    });
  } else {
    logger.info('all batches enqueued for stream', { stream_id, total: newQueued });
  }
}

async function provisionVastInstance(
  streamId: string,
  stream: { id: string; state: string; total_videos: number; duration_secs: number; gpu_count: number },
  env: Env,
): Promise<void> {
  // ── Idempotency guard ────────────────────────────────────────────────────────
  // Reload fresh state from DB — the stream object passed in may be stale.
  const existing = await env.DB
    .prepare('SELECT vast_instance_id FROM streams WHERE id = ?')
    .bind(streamId)
    .first<{ vast_instance_id: string | null }>();

  const currentId = existing?.vast_instance_id ?? null;

  if (currentId && currentId !== 'pending') {
    // Real instance already assigned — skip.
    logger.info('vast instance already assigned, skipping provision', {
      stream_id: streamId,
      instance_id: currentId,
    });
    return;
  }

  // 'pending' → a previous invocation is in progress or crashed.
  // We proceed anyway — the CAS UPDATE below is the true lock.
  // If another worker is actively provisioning, the CAS UPDATE will match 0 rows
  // and we'll exit early below.

  // ── Atomic claim: only one worker provisions at a time ───────────────────────
  // Use a CAS (compare-and-swap) pattern: only update if still NULL or 'pending'.
  const result = await env.DB
    .prepare(`UPDATE streams SET vast_instance_id = 'pending' WHERE id = ? AND (vast_instance_id IS NULL OR vast_instance_id = 'pending')`)
    .bind(streamId)
    .run();

  // If this worker didn't win the CAS, another is provisioning — skip.
  // (changes = 0 when the WHERE clause matched 0 rows, which can happen if a
  //  real instance ID was just written between our SELECT and this UPDATE.)
  if ((result as { meta?: { changes?: number } }).meta?.changes === 0 && currentId && currentId !== 'pending') {
    logger.info('lost provisioning race, skipping', { stream_id: streamId });
    return;
  }

  // ── Run provisioning inside try/catch so we never leave 'pending' on error ───
  try {
    await runProvisioning(streamId, stream, env);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('provisionVastInstance failed — resetting to pending for reaper retry', {
      stream_id: streamId,
      error: errMsg,
    });
    // Keep 'pending' so the reaper detects it after PROVISION_TIMEOUT_MIN and retries.
    // Do NOT reset to NULL here — NULL is invisible to the reaper's pending sweep.
  }
}

async function runProvisioning(
  streamId: string,
  stream: { id: string; state: string; total_videos: number; duration_secs: number; gpu_count: number },
  env: Env,
): Promise<void> {
  const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
  const gpuCount = stream.gpu_count ?? 1;

  // Parse excluded machine IDs from env (comma-separated integers).
  const excludedMachines = (env.VAST_EXCLUDED_MACHINES ?? '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

  // Search: prefer RTX 5090, fall back to any GPU meeting minimums.
  // Exclude CN: local inet_down looks fast but R2 throughput from China is ~20 MB/s
  // (vs 150+ MB/s from US/EU), causing 2–3× slower cold starts.
  const baseQuery = {
    min_gpu_ram: GPU_MIN_VRAM_GB,
    min_cpu_ram: GPU_MIN_RAM_GB,   // system RAM doesn't scale with GPU count — it's one machine
    min_disk_space: GPU_MIN_DISK_GB,
    min_reliability: GPU_MIN_RELIABILITY,
    min_inet_down: GPU_MIN_INET_DOWN,
    num_gpus: gpuCount,
    excluded_countries: ['CN', 'KR'],  // CN: slow R2; KR: Vast infra docker_build errors
    excluded_machine_ids: excludedMachines,
    order: 'dph_total asc',
    limit: 10,
  };

  logger.info('searching Vast.ai GPU offers', { stream_id: streamId, gpu_count: gpuCount });

  let offers = await vast.searchOffers({ ...baseQuery, gpu_name: GPU_PREFERRED });

  if (offers.length === 0) {
    logger.warn('no RTX 5090 available, searching fallback GPUs', { stream_id: streamId, gpu_count: gpuCount });
    offers = await vast.searchOffers(baseQuery);
  }

  if (offers.length === 0) {
    logger.error('no suitable GPU offers found — will retry on next reaper run', { stream_id: streamId });
    // Keep 'pending' — reaper will reset and re-enqueue after PROVISION_TIMEOUT_MIN.
    return;
  }

  logger.info('found GPU offers', { stream_id: streamId, count: offers.length, best_geo: (offers[0] as {geolocation?:string}).geolocation ?? '?' });

  const controlPlaneUrl = env.CONTROL_PLANE_URL;

  // Use slim bootstrap (models-only) when running a pre-built Docker image,
  // full bootstrap otherwise. Switch by changing WORKER_IMAGE above.
  const isPrebuiltImage = !WORKER_IMAGE.startsWith('pytorch/pytorch');
  const bootstrapUrl = isPrebuiltImage
    ? `${controlPlaneUrl}/worker/bootstrap-models.sh`
    : `${controlPlaneUrl}/worker/bootstrap.sh`;

  // Embed env vars directly in the onstart command.
  // extra_env is ignored by Vast.ai's container runtime for onstart scripts;
  // exporting inline is the only reliable way to pass secrets to bootstrap.sh.
  // WORKER_SECRET and LTX_API_KEY are shell-safe strings (hex / alphanumeric).
  const onstart = [
    `export CONTROL_PLANE_URL='${controlPlaneUrl}'`,
    `export STREAM_ID='${streamId}'`,
    `export WORKER_SECRET='${env.WORKER_SECRET}'`,
    `export TOTAL_VIDEOS='${stream.total_videos}'`,
    `export GPU_COUNT='${gpuCount}'`,
    `export HF_TOKEN='${env.HF_TOKEN ?? ''}'`,
    // R2 model bucket credentials — fast model download (~500 MB/s vs HF's 11 MB/s).
    // Set R2_MODEL_KEY_ID + R2_MODEL_SECRET secrets once credentials are created in CF dashboard.
    `export R2_MODEL_KEY_ID='${env.R2_MODEL_KEY_ID ?? ''}'`,
    `export R2_MODEL_SECRET='${env.R2_MODEL_SECRET ?? ''}'`,
    `bash <(curl -fsSL ${bootstrapUrl})`,
  ].join('; ');

  // Try offers in order — skip any that fail to start (e.g. docker_build errors on bad hosts).
  // Vast.ai host-level errors (disk full, permission issues) can happen even on reliable offers.
  let instance = null;
  let usedOffer = offers[0]!;

  for (let attempt = 0; attempt < offers.length; attempt++) {
    usedOffer = offers[attempt]!;
    try {
      logger.info('attempting to start Vast instance', {
        stream_id: streamId,
        offer_id: usedOffer.id,
        geo: (usedOffer as {geolocation?:string}).geolocation ?? '?',
        attempt: attempt + 1,
      });
      instance = await vast.startInstance(usedOffer.id, {
        image: WORKER_IMAGE,
        disk: GPU_MIN_DISK_GB,
        label: `stream-${streamId.slice(0, 8)}`,
        onstart,
      });
      break; // success — stop trying
    } catch (err) {
      logger.warn('vast startInstance failed, trying next offer', {
        stream_id: streamId,
        offer_id: usedOffer.id,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      // Brief pause before trying next offer to avoid hammering the API.
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!instance) {
    // All offers failed — keep 'pending' so reaper will retry.
    logger.error('all offers failed to start — will retry on next reaper run', {
      stream_id: streamId,
      tried: offers.length,
    });
    return;
  }

  await env.DB
    .prepare(`UPDATE streams SET vast_instance_id = ? WHERE id = ?`)
    .bind(String(instance.id), streamId)
    .run();

  logger.info('vast instance started', {
    stream_id: streamId,
    instance_id: instance.id,
    gpu: usedOffer.gpu_name,
    geo: (usedOffer as {geolocation?:string}).geolocation ?? '?',
    dph: usedOffer.dph_total,
  });
}
