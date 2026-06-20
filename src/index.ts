/**
 * Cloudflare Worker entry point.
 *
 * Exports two handlers:
 * - fetch: handles incoming HTTP requests (Telegram webhooks + health check)
 * - queue: handles batches from render-queue and publish-queue
 *
 * The fetch and queue handlers are completely separate code paths.
 * A crash in one cannot directly affect the other.
 */

import type { Env } from './config/env.js';
import { configureLogger, logger } from './lib/logger.js';
import { handleTelegramRequest } from './telegram/router.js';
import { handleRenderBatch } from './queues/render-consumer.js';
import { handlePublishBatch } from './queues/publish-consumer.js';
import { handleStreamBatch } from './queues/stream-consumer.js';
import { handleWorkerRequest } from './worker-api/routes.js';
import { verifyWorkerAuth, unauthorizedResponse } from './worker-api/auth.js';
import { runReaper } from './cron/reaper.js';
import bootstrapSh from './worker/bootstrap.sh';
import bootstrapModelsSh from './worker/bootstrap-models.sh';
import workerPy from './worker/worker.py';
import workflowJson from './worker/workflow.json';

export default {
  // ── HTTP handler ─────────────────────────────────────────────────────────────
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    configureLogger(env.LOG_LEVEL === 'debug' ? 'debug' : 'info');

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — no auth required.
    if (path === '/health') {
      return Response.json({ status: 'ok', ts: new Date().toISOString() });
    }

    // Telegram webhooks.
    if (
      path === env.CONTROL_BOT_WEBHOOK_PATH ||
      path === env.PUBLISHER_BOT_WEBHOOK_PATH
    ) {
      return handleTelegramRequest(request, env);
    }

    // Worker static assets — no auth needed (downloaded by Vast instance on boot,
    // before it has received the WORKER_SECRET env var).
    if (path === '/worker/bootstrap.sh') {
      return new Response(bootstrapSh, {
        headers: { 'Content-Type': 'text/x-sh; charset=utf-8' },
      });
    }
    // Slim bootstrap for pre-built Docker image — only downloads models.
    if (path === '/worker/bootstrap-models.sh') {
      return new Response(bootstrapModelsSh, {
        headers: { 'Content-Type': 'text/x-sh; charset=utf-8' },
      });
    }
    if (path === '/worker/worker.py') {
      return new Response(workerPy, {
        headers: { 'Content-Type': 'text/x-python; charset=utf-8' },
      });
    }
    if (path === '/worker/workflow.json') {
      return new Response(JSON.stringify(workflowJson), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Debug: test R2 REST client PUT to an operator bucket — Bearer auth required.
    // GET /debug/r2-test?bucket=<name>  — writes a small text object and reads it back.
    if (path === '/debug/r2-test' && request.method === 'GET') {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) return unauthorizedResponse();
      const bucketName = url.searchParams.get('bucket') ?? '555';
      const { R2Client } = await import('./r2/client.js');
      const testKey = 'debug/r2-test-probe.txt';
      const testBody = `R2 test at ${new Date().toISOString()}`;
      const logs: string[] = [];
      try {
        const client = R2Client.forBucket(bucketName, env.R2_ACCOUNT_ID, env.R2_ACCOUNT_TOKEN);
        await client.put(testKey, testBody, 'text/plain');
        logs.push(`PUT ok → ${bucketName}/${testKey}`);
        return Response.json({ ok: true, logs });
      } catch (err) {
        logs.push(`PUT failed: ${err instanceof Error ? err.message : String(err)}`);
        return Response.json({ ok: false, logs }, { status: 500 });
      }
    }

    // POST /debug/re-enqueue — re-sends a queued stream's first message to stream-queue.
    // Use when stream is stuck in 'queued' state (consumer crashed or message was lost).
    if (path === '/debug/re-enqueue' && request.method === 'POST') {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) return unauthorizedResponse();
      const { streamId } = await request.json() as { streamId?: string };
      if (!streamId) return Response.json({ error: 'streamId required' }, { status: 400 });
      const stream = await env.DB
        .prepare('SELECT id, state, total_videos, user_id FROM streams WHERE id = ?')
        .bind(streamId)
        .first<{ id: string; state: string; total_videos: number; user_id: number }>();
      if (!stream) return Response.json({ error: 'stream not found' }, { status: 404 });
      const { enqueueStreamLaunch } = await import('./queues/stream-producer.js');
      const batchSize = Math.min(stream.total_videos, parseInt(env.PROMPT_BATCH_SIZE ?? '20', 10));
      await enqueueStreamLaunch(env.STREAM_QUEUE, {
        stream_id: streamId,
        user_id: stream.user_id,
        batch_index: 0,
        batch_size: batchSize,
        seq_start: 1,
      });
      return Response.json({ ok: true, stream_id: streamId, batch_size: batchSize, state: stream.state });
    }

    // POST /worker/debug/report — GPU worker posts ComfyUI node info here after startup.
    if (path === '/worker/debug/report' && request.method === 'POST') {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) return unauthorizedResponse();
      const body = await request.text();
      await env.R2_ADMIN.put('debug/comfy-report.json', body, {
        httpMetadata: { contentType: 'application/json' },
      });
      return Response.json({ ok: true });
    }

    // GET /debug/comfy-report — read the latest ComfyUI node report from the GPU worker.
    if (path === '/debug/comfy-report' && request.method === 'GET') {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) return unauthorizedResponse();
      const obj = await env.R2_ADMIN.get('debug/comfy-report.json');
      if (!obj) return Response.json({ error: 'no report yet — instance still bootstrapping' }, { status: 404 });
      const text = await obj.text();
      return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    }

    // POST /debug/run-reaper — run all reaper sweeps once, on demand (Bearer auth).
    // Lets us test sweep behaviour deterministically instead of waiting for the cron.
    if (path === '/debug/run-reaper' && request.method === 'POST') {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) return unauthorizedResponse();
      try {
        await runReaper(env);
        return Response.json({ ok: true, ran_at: new Date().toISOString() });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Debug: Vast.ai offer search — Bearer auth required.
    if (path === '/debug/vast-search' && request.method === 'GET') {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) return unauthorizedResponse();
      const { VastClient } = await import('./vast/client.js');
      const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
      const base = { min_gpu_ram: 30, min_cpu_ram: 48, min_disk_space: 120, min_reliability: 0.98, min_inet_down: 500, num_gpus: 1, excluded_countries: ['CN','KR'], order: 'dph_total asc', limit: 20 };
      const [preferred, fallback] = await Promise.all([
        vast.searchOffers({ ...base, gpu_name: 'RTX 5090' }).catch((e: unknown) => ({ error: String(e) })),
        vast.searchOffers(base).catch((e: unknown) => ({ error: String(e) })),
      ]);
      return Response.json({ preferred, fallback });
    }

    // Debug: test Vast.ai startInstance + getInstance end-to-end — Bearer auth required.
    // POST /debug/vast-provision?stream_id=<id>  — actually provisions the given stream.
    if (path === '/debug/vast-provision' && request.method === 'POST') {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) return unauthorizedResponse();
      const streamId = url.searchParams.get('stream_id');
      if (!streamId) return Response.json({ error: 'stream_id required' }, { status: 400 });

      const { VastClient } = await import('./vast/client.js');
      const { VastApiError } = await import('./vast/types.js');
      const logs: string[] = [];
      const log = (msg: string) => { logs.push(msg); logger.info(msg); };

      const stream = await env.DB
        .prepare('SELECT id, state, total_videos, duration_secs, gpu_count FROM streams WHERE id = ?')
        .bind(streamId).first<{ id: string; state: string; total_videos: number; duration_secs: number; gpu_count: number }>();
      if (!stream) return Response.json({ error: 'stream not found', logs }, { status: 404 });

      log(`Stream: ${stream.id}, state=${stream.state}, gpu_count=${stream.gpu_count}`);

      const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
      const gpuCount = stream.gpu_count ?? 1;
      const base = { min_gpu_ram: 30, min_cpu_ram: 48, min_disk_space: 120, min_reliability: 0.98, min_inet_down: 500, num_gpus: gpuCount, excluded_countries: ['CN','KR'], order: 'dph_total asc', limit: 10 };

      log(`Searching RTX 5090 offers (gpu_count=${gpuCount})...`);
      let offers = await vast.searchOffers({ ...base, gpu_name: 'RTX 5090' }).catch((e: unknown) => { log(`searchOffers RTX 5090 error: ${e}`); return []; });
      log(`RTX 5090 offers: ${offers.length}`);
      if (offers.length === 0) {
        offers = await vast.searchOffers(base).catch((e: unknown) => { log(`searchOffers fallback error: ${e}`); return []; });
        log(`Fallback offers: ${offers.length}`);
      }
      if (offers.length === 0) return Response.json({ error: 'no offers', logs });

      const offer = offers[0]!;
      log(`Best offer: id=${offer.id} dph=$${offer.dph_total?.toFixed(3)} geo=${(offer as { geolocation?: string }).geolocation}`);

      const controlPlaneUrl = env.CONTROL_PLANE_URL;
      const onstart = [
        `export CONTROL_PLANE_URL='${controlPlaneUrl}'`,
        `export STREAM_ID='${streamId}'`,
        `export WORKER_SECRET='${env.WORKER_SECRET}'`,
        `export TOTAL_VIDEOS='${stream.total_videos}'`,
        `export GPU_COUNT='${gpuCount}'`,
        `export HF_TOKEN='${env.HF_TOKEN ?? ''}'`,
        `export R2_MODEL_KEY_ID='${env.R2_MODEL_KEY_ID ?? ''}'`,
        `export R2_MODEL_SECRET='${env.R2_MODEL_SECRET ?? ''}'`,
        `bash <(curl -fsSL ${controlPlaneUrl}/worker/bootstrap.sh)`,
      ].join('; ');

      log(`Calling startInstance for offer ${offer.id}...`);
      try {
        const instance = await vast.startInstance(offer.id, {
          image: 'pytorch/pytorch:2.6.0-cuda12.6-cudnn9-runtime',
          disk: 120,
          label: `stream-${streamId.slice(0, 8)}`,
          onstart,
        });
        log(`Instance created: id=${instance.id} status=${instance.actual_status}`);
        await env.DB.prepare('UPDATE streams SET vast_instance_id = ? WHERE id = ?').bind(String(instance.id), streamId).run();
        log(`DB updated: vast_instance_id = ${instance.id}`);
        return Response.json({ ok: true, instance_id: instance.id, offer_id: offer.id, logs });
      } catch (err: unknown) {
        const msg = err instanceof VastApiError
          ? `VastApiError(${(err as InstanceType<typeof VastApiError>).operation}, HTTP ${(err as InstanceType<typeof VastApiError>).status}): ${(err as Error).message}`
          : String(err);
        log(`startInstance FAILED: ${msg}`);
        return Response.json({ error: msg, logs }, { status: 500 });
      }
    }

    // Worker API — all other /worker/* routes require Bearer auth.
    if (path.startsWith('/worker/')) {
      if (!verifyWorkerAuth(request, env.WORKER_SECRET)) {
        return unauthorizedResponse();
      }
      return handleWorkerRequest(request, env, path);
    }

    logger.debug('unmatched path', { path, method: request.method });
    return new Response('Not Found', { status: 404 });
  },

  // ── Queue consumer ────────────────────────────────────────────────────────────
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    configureLogger(env.LOG_LEVEL === 'debug' ? 'debug' : 'info');

    switch (batch.queue) {
      case 'stream-queue':
        return handleStreamBatch(batch, env);

      case 'render-queue':
        return handleRenderBatch(batch, env);

      case 'publish-queue':
        return handlePublishBatch(batch, env);

      default:
        // Unknown queue — ack all to prevent DLQ noise from misconfiguration.
        logger.warn('unknown queue, acking all messages', { queue: batch.queue });
        batch.ackAll();
    }
  },
  // ── Cron handler ─────────────────────────────────────────────────────────────
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    configureLogger(env.LOG_LEVEL === 'debug' ? 'debug' : 'info');
    ctx.waitUntil(runReaper(env));
  },
} satisfies ExportedHandler<Env>;
