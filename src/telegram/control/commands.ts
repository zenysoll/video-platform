/**
 * Control bot slash commands: /status, /streams, and stream action handlers.
 */

import type { Env } from '../../config/env.js';
import { telegramCall } from '../types.js';
import {
  getStreamsForUser, getActiveStreamsForUser, getDraftStreamsForUser,
  getStream, transitionStreamToQueued, cancelStream, forceKillStream,
} from '../../db/queries.js';
import { enqueueStreamLaunch } from '../../queues/stream-producer.js';
import { VastClient } from '../../vast/client.js';
import { logger } from '../../lib/logger.js';

/** 💎 (max) / 🎬 (max2) prefix marks quality streams wherever a stream name is rendered. */
function modeBadge(s: { quality_mode?: string }): string {
  if (s.quality_mode === 'max') return '💎 ';
  if (s.quality_mode === 'max2') return '🎬 ';
  return '';
}

export async function handleStreamsCommand(chatId: number, userId: number, env: Env): Promise<void> {
  const [drafts, streams] = await Promise.all([
    getDraftStreamsForUser(env.DB, userId),
    getStreamsForUser(env.DB, userId),
  ]);

  if (streams.length === 0 && drafts.length === 0) {
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: 'No streams yet. Use "New stream" to create one.',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  // Show drafts with Launch/Cancel buttons first.
  for (const s of drafts) {
    const sizeStr = s.aspect_ratio === 'custom'
      ? `${s.width}×${s.height}`
      : s.aspect_ratio ?? '?';
    const info = [
      `Name:     ${s.name}`,
      `Videos:   ${s.total_videos}`,
      `Size:     ${sizeStr}`,
      `FPS:      ${s.fps}`,
      `Duration: ${s.duration_secs}s`,
      `Sound:    ${s.sound_enabled ? 'On' : 'Off'}`,
    ].join('\n');

    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: `[DRAFT] ${modeBadge(s)}${s.name}\n\n${info}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Launch', callback_data: `stream:launch:${s.id}` },
            { text: 'Delete', callback_data: `stream:cancel:${s.id}` },
          ],
        ],
      },
    }, env.CONTROL_BOT_TOKEN);
  }

  // Active streams (running/queued) — show each with a Kill button so the operator
  // can stop them right here, not only from /status.
  const active = streams.filter(s => s.state === 'running' || s.state === 'queued');
  for (const s of active) {
    const progress = `${s.videos_published}/${s.total_videos} published · rendered ${s.videos_rendered}`;
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: `${modeBadge(s)}${s.name}  [${s.state}]\n${progress}`,
      reply_markup: {
        inline_keyboard: [[
          { text: `⛔ Kill "${s.name}"`, callback_data: `stream:kill:${s.id}` },
        ]],
      },
    }, env.CONTROL_BOT_TOKEN);
  }

  // Finished streams (completed/failed/cancelled) — compact list, no buttons.
  const finished = streams.filter(s =>
    s.state === 'completed' || s.state === 'failed' || s.state === 'cancelled');
  if (finished.length > 0) {
    const lines = finished.map(s =>
      `• ${modeBadge(s)}${s.name}  [${s.state}]  ${s.videos_published}/${s.total_videos} published`);
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: `Finished:\n\n${lines.join('\n')}`,
    }, env.CONTROL_BOT_TOKEN);
  }
}

// ── Status command ────────────────────────────────────────────────────────────

/** Send a fresh status message (called by /status command). */
export async function handleStatusCommand(chatId: number, userId: number, env: Env): Promise<void> {
  const { text, markup } = await buildStatusPayload(userId, env);
  await telegramCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: markup,
  }, env.CONTROL_BOT_TOKEN);
}

/** Edit the existing status message in-place (called by Refresh button). */
export async function handleStatusRefresh(
  chatId: number,
  userId: number,
  messageId: number | undefined,
  env: Env,
): Promise<void> {
  const { text, markup } = await buildStatusPayload(userId, env);
  if (messageId) {
    await telegramCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: markup,
    }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: markup,
    }, env.CONTROL_BOT_TOKEN);
  }
}

async function buildStatusPayload(userId: number, env: Env): Promise<{ text: string; markup: object }> {
  const active = await getActiveStreamsForUser(env.DB, userId);

  if (active.length === 0) {
    return {
      text: 'No active streams.',
      markup: { inline_keyboard: [] },
    };
  }

  // Fetch Vast.ai instance info in parallel for all streams that have one.
  const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
  const instanceInfos = await Promise.all(
    active.map(async s => {
      const instanceId = s.vast_instance_id;
      if (!instanceId || instanceId === 'pending') return null;
      try {
        return await vast.getInstance(Number(instanceId));
      } catch {
        return null;
      }
    }),
  );

  const now = Date.now() / 1000; // unix seconds
  const lines: string[] = [];
  // Kill buttons — one per active stream, grouped together under refresh
  const killButtons: { text: string; callback_data: string }[] = [];

  for (let i = 0; i < active.length; i++) {
    const s = active[i]!;
    const inst = instanceInfos[i];

    const total = s.total_videos;
    const pub = s.videos_published;
    const ren = s.videos_rendered;
    const queued = s.videos_queued;
    const failed = s.videos_failed ?? 0;
    const pct = total > 0 ? Math.round((pub / total) * 100) : 0;

    // 10-char ASCII progress bar
    const filled = Math.round(pct / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    // Instance line
    let gpuLine: string;
    if (!s.vast_instance_id) {
      gpuLine = 'GPU: —';
    } else if (s.vast_instance_id === 'pending') {
      gpuLine = 'GPU: provisioning…';
    } else if (inst) {
      const uptimeSec = inst.start_date ? Math.max(0, now - inst.start_date) : 0;
      const uptimeMin = Math.round(uptimeSec / 60);
      const cost = inst.dph_total ? (inst.dph_total * uptimeSec / 3600).toFixed(3) : '?';
      const status = inst.actual_status;
      gpuLine = `GPU: ${inst.gpu_name}  #${inst.id}  [${status}]  ${uptimeMin}min  ~$${cost}`;
    } else {
      gpuLine = `GPU: #${s.vast_instance_id} (fetching…)`;
    }

    lines.push([
      `<b>${modeBadge(s)}${s.name}</b>  [${s.state}]`,
      `[${bar}] ${pct}%  ${pub}/${total} published`,
      `Rendered: ${ren}  Queued: ${queued}${failed > 0 ? `  Failed: ${failed}` : ''}`,
      gpuLine,
    ].join('\n'));

    killButtons.push({ text: `⛔ Kill "${s.name}"`, callback_data: `stream:kill:${s.id}` });
  }

  const ts = new Date().toISOString().slice(11, 19) + ' UTC';
  const text = `<b>Active streams</b>  (${ts})\n\n${lines.join('\n\n')}`;

  const markup = {
    inline_keyboard: [
      [{ text: '↻ Refresh', callback_data: 'status:refresh' }],
      ...killButtons.map(btn => [btn]),
    ],
  };

  return { text, markup };
}

// ── Stream launch / cancel ────────────────────────────────────────────────────

/** Handle "Launch" button tap on a draft stream. */
export async function handleStreamLaunch(
  chatId: number,
  userId: number,
  streamId: string,
  messageId: number | undefined,
  env: Env,
): Promise<void> {
  const stream = await getStream(env.DB, streamId);
  if (!stream || stream.user_id !== userId) {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: 'Stream not found.',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }
  if (stream.state !== 'draft') {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: `Stream is already ${stream.state}.`,
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  await transitionStreamToQueued(env.DB, streamId);

  const batchSize = Math.min(
    stream.total_videos,
    parseInt(env.PROMPT_BATCH_SIZE ?? '20', 10),
  );

  await enqueueStreamLaunch(env.STREAM_QUEUE, {
    stream_id: streamId,
    user_id: userId,
    batch_index: 0,
    batch_size: batchSize,
    seq_start: 1,
  });

  logger.info('stream launched', { stream_id: streamId, user_id: userId });

  const confirmText = `Stream "${stream.name}" launched.\n\nGenerating ${stream.total_videos} prompts and queueing render jobs.`;

  if (messageId) {
    await telegramCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: confirmText,
      reply_markup: {
        inline_keyboard: [[
          { text: '↻ Status', callback_data: 'status:refresh' },
        ]],
      },
    }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: confirmText,
    }, env.CONTROL_BOT_TOKEN);
  }
}

/**
 * Force-kill a running/queued stream.
 * Cancels all pending jobs and destroys the Vast.ai instance if one is assigned.
 */
export async function handleStreamKill(
  chatId: number,
  userId: number,
  streamId: string,
  messageId: number | undefined,
  env: Env,
): Promise<void> {
  const stream = await getStream(env.DB, streamId);
  if (!stream || stream.user_id !== userId) {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: 'Stream not found.',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  if (stream.state === 'completed' || stream.state === 'cancelled') {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: `Stream is already ${stream.state}.`,
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  // Cancel in DB first (idempotent — safe to do before Vast call).
  await forceKillStream(env.DB, streamId);
  logger.info('stream force-killed', { stream_id: streamId, user_id: userId });

  // Destroy Vast instance if one was provisioned.
  const instanceId = stream.vast_instance_id;
  let instanceNote = '';
  if (instanceId && instanceId !== 'pending') {
    try {
      const vast = new VastClient(env.VAST_API_KEY, env.VAST_API_BASE_URL);
      await vast.destroyInstance(Number(instanceId));
      instanceNote = `\nGPU instance #${instanceId} destroyed.`;
      logger.info('vast instance destroyed via force kill', { stream_id: streamId, instance_id: instanceId });
    } catch (err) {
      instanceNote = `\nNote: could not destroy GPU instance #${instanceId} (may already be gone).`;
      logger.warn('failed to destroy instance during force kill', {
        stream_id: streamId,
        instance_id: instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const text = `Stream "${stream.name}" killed.${instanceNote}`;
  if (messageId) {
    await telegramCall('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
    }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', { chat_id: chatId, text }, env.CONTROL_BOT_TOKEN);
  }
}

/** Handle "Delete" button tap on a draft stream. */
export async function handleStreamCancel(
  chatId: number,
  userId: number,
  streamId: string,
  messageId: number | undefined,
  env: Env,
): Promise<void> {
  const stream = await getStream(env.DB, streamId);
  if (!stream || stream.user_id !== userId) return;

  await cancelStream(env.DB, streamId);

  const text = `Stream "${stream.name}" deleted.`;
  if (messageId) {
    await telegramCall('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
    }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', { chat_id: chatId, text }, env.CONTROL_BOT_TOKEN);
  }
}
