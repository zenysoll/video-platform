/**
 * Stream creation wizard for the control bot.
 *
 * Each step either:
 * - Sends a message with an inline keyboard (buttons), or
 * - Expects free-text input from the user.
 *
 * State is persisted in D1 between messages via session.ts.
 *
 * Step order:
 *   wizard_quality → wizard_name → wizard_total_videos → wizard_aspect_ratio
 *   → (custom) wizard_custom_width → wizard_custom_height
 *   → wizard_fps → wizard_duration → wizard_sound
 *   → wizard_gpu_count → wizard_bucket → (new) wizard_bucket_name
 *   → wizard_confirm → done (stream saved in D1 as 'draft')
 */

import type { Env } from '../../config/env.js';
import { telegramCall, type TelegramCallbackQuery, type TelegramMessage } from '../types.js';
import { loadSession, saveSession, resetToIdle, type WizardData, type WizardStep } from './session.js';
import { getBucketsForUser, insertBucket, activateBucket, deactivateBucket, insertStream, transitionStreamToQueued } from '../../db/queries.js';
import { enqueueStreamLaunch } from '../../queues/stream-producer.js';
import { generateId } from '../../lib/idempotency.js';
import { R2Client } from '../../r2/client.js';
import { logger } from '../../lib/logger.js';
import { sendMainMenu } from './menu.js';

// ── Entry points ──────────────────────────────────────────────────────────────

/** Called when operator taps "New stream" button. */
export async function startWizardFlow(
  chatId: number,
  userId: number,
  env: Env,
): Promise<void> {
  await saveSession(env.DB, userId, 'wizard_quality', {});
  await telegramCall('sendMessage', {
    chat_id: chatId,
    text: `Quality:\n\n⚡ Flex — fast and cheap, the current production look\n💎 Max — realism engine (Wan 2.2), same hardware price, ~2× render time`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚡ Flex — fast & cheap', callback_data: 'qm:flex' }],
        [{ text: '💎 Max — realism engine', callback_data: 'qm:max' }],
        [cancelButton()],
      ],
    },
  }, env.CONTROL_BOT_TOKEN);
}

/** Called when operator sends a text message during an active wizard. */
export async function handleWizardText(
  message: TelegramMessage,
  env: Env,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from!.id;
  const text = message.text?.trim() ?? '';

  const session = await loadSession(env.DB, userId);
  if (!session.step?.startsWith('wizard_')) return;

  const step = session.step as WizardStep;
  const data = session.wizardData;

  switch (step) {
    case 'wizard_name':
      return handleNameInput(chatId, userId, text, data, env);

    case 'wizard_total_videos':
      return handleTotalVideosInput(chatId, userId, text, data, env);

    case 'wizard_custom_width':
      return handleCustomWidthInput(chatId, userId, text, data, env);

    case 'wizard_custom_height':
      return handleCustomHeightInput(chatId, userId, text, data, env);

    case 'wizard_duration':
      return handleDurationInput(chatId, userId, text, data, env);

    case 'wizard_bucket_name':
      return handleBucketNameInput(chatId, userId, text, data, env);

    default:
      await telegramCall('sendMessage', {
        chat_id: chatId,
        text: 'Please use the buttons to continue.',
      }, env.CONTROL_BOT_TOKEN);
  }
}

/** Called when operator taps a wizard inline button. */
export async function handleWizardCallback(
  query: TelegramCallbackQuery,
  env: Env,
): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const userId = query.from.id;
  const data = query.data ?? '';

  if (!chatId) return;

  const session = await loadSession(env.DB, userId);
  const wizardData = session.wizardData;

  if (data === 'wizard:cancel') {
    await resetToIdle(env.DB, userId);
    await editMessage(chatId, messageId, 'Cancelled.', undefined, env);
    await sendMainMenu(chatId, env);
    return;
  }

  const step = session.step as WizardStep | null;

  if (step === 'wizard_quality' && data.startsWith('qm:')) {
    return handleQualityChoice(chatId, userId, data.slice(3), wizardData, env, messageId);
  }

  if (step === 'wizard_total_videos' && data.startsWith('tvid:')) {
    const n = parseInt(data.slice(5), 10);
    return handleTotalVideosInput(chatId, userId, String(n), wizardData, env, messageId);
  }

  if (step === 'wizard_aspect_ratio' && data.startsWith('ar:')) {
    return handleAspectRatioChoice(chatId, userId, data.slice(3), wizardData, env, messageId);
  }

  if (step === 'wizard_fps' && data.startsWith('fps:')) {
    const fps = parseInt(data.slice(4), 10);
    return handleFpsChoice(chatId, userId, fps, wizardData, env, messageId);
  }

  if (step === 'wizard_duration' && data.startsWith('dur:')) {
    return handleDurationInput(chatId, userId, data.slice(4), wizardData, env, messageId);
  }

  if (step === 'wizard_sound' && data.startsWith('snd:')) {
    const soundEnabled = data.slice(4) === 'on';
    return handleSoundChoice(chatId, userId, soundEnabled, wizardData, env, messageId);
  }

  if (step === 'wizard_gpu_count' && data.startsWith('gpu:')) {
    const gpuCount = parseInt(data.slice(4), 10);
    return handleGpuCountChoice(chatId, userId, gpuCount, wizardData, env, messageId);
  }

  if (step === 'wizard_bucket' && data.startsWith('bkt:')) {
    const bucketId = data.slice(4);
    if (bucketId === 'new') {
      await saveSession(env.DB, userId, 'wizard_bucket_name', wizardData);
      await editMessage(chatId, messageId, 'Enter a name for the new R2 bucket (lowercase letters, numbers, hyphens):', undefined, env);
    } else {
      return handleBucketChoice(chatId, userId, bucketId, wizardData, env, messageId);
    }
    return;
  }

  if (step === 'wizard_confirm' && data === 'confirm:launch') {
    return handleConfirmLaunch(chatId, userId, wizardData, env, messageId);
  }
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleQualityChoice(
  chatId: number, userId: number, choice: string, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  // Only the three button payloads are valid — anything else (stale button,
  // forged callback) restarts the step instead of writing garbage into D1.
  if (choice !== 'flex' && choice !== 'max') {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: 'Please use the buttons to choose a quality mode.',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  data.quality_mode = choice;
  await saveSession(env.DB, userId, 'wizard_name', data);
  await editMessage(
    chatId, messageId,
    `Quality: ${qualityLabel(choice)}\n\nStream name:`,
    undefined, env,
  );
}

async function handleNameInput(
  chatId: number, userId: number, text: string, data: WizardData, env: Env,
): Promise<void> {
  if (!text || text.length > 64) {
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: 'Stream name must be 1–64 characters. Try again:',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  data.name = text;
  await saveSession(env.DB, userId, 'wizard_total_videos', data);
  await telegramCall('sendMessage', {
    chat_id: chatId,
    text: `Name: ${text}\n\nNumber of videos:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '10',   callback_data: 'tvid:10' },
          { text: '50',   callback_data: 'tvid:50' },
          { text: '100',  callback_data: 'tvid:100' },
        ],
        [
          { text: '500',  callback_data: 'tvid:500' },
          { text: '1000', callback_data: 'tvid:1000' },
        ],
        [cancelButton()],
      ],
    },
  }, env.CONTROL_BOT_TOKEN);
}

async function handleTotalVideosInput(
  chatId: number, userId: number, text: string, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  const n = parseInt(text, 10);
  if (!n || n < 1 || n > 10000) {
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: 'Enter a number between 1 and 10000:',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  data.total_videos = n;
  await saveSession(env.DB, userId, 'wizard_aspect_ratio', data);

  const body = {
    chat_id: chatId,
    text: `Videos: ${n}\n\nAspect ratio:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '9:16 (vertical)',   callback_data: 'ar:9:16' },
          { text: '16:9 (horizontal)', callback_data: 'ar:16:9' },
        ],
        [
          { text: '1:1 (square)',      callback_data: 'ar:1:1' },
          { text: 'Custom size',       callback_data: 'ar:custom' },
        ],
        [cancelButton()],
      ],
    },
  };

  if (messageId) {
    await telegramCall('editMessageText', { ...body, message_id: messageId }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', body, env.CONTROL_BOT_TOKEN);
  }
}

async function handleAspectRatioChoice(
  chatId: number, userId: number, ar: string, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  if (ar === 'custom') {
    data.aspect_ratio = 'custom';
    await saveSession(env.DB, userId, 'wizard_custom_width', data);
    await editMessage(chatId, messageId, 'Enter width in pixels (e.g. 1280):', undefined, env);
    return;
  }

  data.aspect_ratio = ar;
  const [w, h] = arToPixels(ar, data.quality_mode === 'max' ? 'max' : 'flex');
  data.width = w;
  data.height = h;
  await saveSession(env.DB, userId, 'wizard_fps', data);
  await sendFpsStep(chatId, messageId, data, env);
}

async function handleCustomWidthInput(
  chatId: number, userId: number, text: string, data: WizardData, env: Env,
): Promise<void> {
  const w = parseInt(text, 10);
  if (!w || w < 64 || w > 4096) {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: 'Width must be between 64 and 4096. Try again:',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }
  data.width = w;
  await saveSession(env.DB, userId, 'wizard_custom_height', data);
  await telegramCall('sendMessage', {
    chat_id: chatId, text: 'Enter height in pixels (e.g. 720):',
  }, env.CONTROL_BOT_TOKEN);
}

async function handleCustomHeightInput(
  chatId: number, userId: number, text: string, data: WizardData, env: Env,
): Promise<void> {
  const h = parseInt(text, 10);
  if (!h || h < 64 || h > 4096) {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: 'Height must be between 64 and 4096. Try again:',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }
  data.height = h;
  await saveSession(env.DB, userId, 'wizard_fps', data);
  await sendFpsStep(chatId, undefined, data, env);
}

async function sendFpsStep(
  chatId: number, messageId: number | undefined, data: WizardData, env: Env,
): Promise<void> {
  // Max renders on Wan's fixed 16 fps grid and smooths via RIFE, so its two
  // delivery options are grid-exact — arbitrary fps values would reintroduce
  // the uneven-cadence judder the operator caught during live calibration.
  const fpsKeyboard = data.quality_mode === 'max'
    ? [
        [{ text: '30 fps — smoothest (recommended)', callback_data: 'fps:30' }],
        [{ text: '32 fps — every frame kept', callback_data: 'fps:32' }],
      ]
    : [[
        { text: '24', callback_data: 'fps:24' },
        { text: '30', callback_data: 'fps:30' },
        { text: '60', callback_data: 'fps:60' },
      ]];
  const body = {
    chat_id: chatId,
    text: data.quality_mode === 'max'
      ? `Size: ${data.width}×${data.height}\n\nMotion smoothness (both are fluid; 30 is the calibrated default):`
      : `Size: ${data.width}×${data.height}\n\nFPS:`,
    reply_markup: {
      inline_keyboard: [
        ...fpsKeyboard,
        [cancelButton()],
      ],
    },
  };
  if (messageId) {
    await telegramCall('editMessageText', { ...body, message_id: messageId }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', body, env.CONTROL_BOT_TOKEN);
  }
}

async function handleFpsChoice(
  chatId: number, userId: number, fps: number, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  // Per-mode whitelist: a stale/forged callback must not write an fps the
  // render path has no grid for (max maps 30→RIFE×4, 32→RIFE×2 — nothing else).
  const allowed = data.quality_mode === 'max' ? [30, 32] : [24, 30, 60];
  if (!allowed.includes(fps)) {
    await sendFpsStep(chatId, messageId, data, env);
    return;
  }
  data.fps = fps;
  await saveSession(env.DB, userId, 'wizard_duration', data);
  await sendDurationStep(chatId, messageId, fps, env);
}

async function sendDurationStep(
  chatId: number, messageId: number | undefined, fps: number, env: Env,
): Promise<void> {
  const body = {
    chat_id: chatId,
    text: `FPS: ${fps}\n\nDuration (seconds) — pick a preset or type any number 1–120:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '3s',  callback_data: 'dur:3' },
          { text: '5s',  callback_data: 'dur:5' },
          { text: '10s', callback_data: 'dur:10' },
        ],
        [
          { text: '15s', callback_data: 'dur:15' },
          { text: '30s', callback_data: 'dur:30' },
          { text: '60s', callback_data: 'dur:60' },
        ],
        [cancelButton()],
      ],
    },
  };
  if (messageId) {
    await telegramCall('editMessageText', { ...body, message_id: messageId }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', body, env.CONTROL_BOT_TOKEN);
  }
}

async function handleDurationInput(
  chatId: number, userId: number, text: string, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  const d = parseInt(text, 10);
  if (!d || d < 1 || d > 120) {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: 'Duration must be between 1 and 120 seconds. Try again:',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }
  data.duration_secs = d;
  await saveSession(env.DB, userId, 'wizard_sound', data);
  await sendSoundStep(chatId, messageId, env);
}

async function sendSoundStep(
  chatId: number, messageId: number | undefined, env: Env,
): Promise<void> {
  const body = {
    chat_id: chatId,
    text: `Sound:\n\n🔊 On — video includes generated audio\n🔇 Off — silent video`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔊 On',  callback_data: 'snd:on' },
          { text: '🔇 Off', callback_data: 'snd:off' },
        ],
        [cancelButton()],
      ],
    },
  };
  if (messageId) {
    await telegramCall('editMessageText', { ...body, message_id: messageId }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', body, env.CONTROL_BOT_TOKEN);
  }
}

async function handleSoundChoice(
  chatId: number, userId: number, soundEnabled: boolean, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  data.sound_enabled = soundEnabled;
  await saveSession(env.DB, userId, 'wizard_gpu_count', data);
  await sendGpuCountStep(chatId, messageId, env);
}

async function sendGpuCountStep(
  chatId: number, messageId: number | undefined, env: Env,
): Promise<void> {
  const body = {
    chat_id: chatId,
    text: `GPU count:\n\n×1 — standard (~$0.20/h, 1× RTX 5090)\n×2 — double speed (~$0.40/h, 2× RTX 5090)\n×4 — max speed (~$0.80/h, 4× RTX 5090)`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '×1 GPU', callback_data: 'gpu:1' },
          { text: '×2 GPU', callback_data: 'gpu:2' },
          { text: '×4 GPU', callback_data: 'gpu:4' },
        ],
        [cancelButton()],
      ],
    },
  };
  if (messageId) {
    await telegramCall('editMessageText', { ...body, message_id: messageId }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', body, env.CONTROL_BOT_TOKEN);
  }
}

async function handleGpuCountChoice(
  chatId: number, userId: number, gpuCount: number, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  data.gpu_count = gpuCount;
  await saveSession(env.DB, userId, 'wizard_bucket', data);
  await sendBucketStep(chatId, userId, messageId, data, env);
}

async function sendBucketStep(
  chatId: number, userId: number, messageId: number | undefined, data: WizardData, env: Env,
): Promise<void> {
  const buckets = await getBucketsForUser(env.DB, userId);

  // Default bucket by quality tier: a max stream should land in the 'max' bucket,
  // a flex stream in 'flex'. The matching bucket is floated to the top and marked
  // ✓ default so the operator taps through without mis-routing tiers.
  const defaultName = data.quality_mode === 'max' ? 'max' : 'flex';
  const ordered = [...buckets].sort((a, b) => {
    const am = a.bucket_name === defaultName ? 0 : 1;
    const bm = b.bucket_name === defaultName ? 0 : 1;
    return am - bm;
  });

  const bucketButtons = ordered.map(b => ([{
    text: b.bucket_name === defaultName ? `✓ ${b.label} (default for ${defaultName})` : b.label,
    callback_data: `bkt:${b.id}`,
  }]));

  const body = {
    chat_id: chatId,
    text: `Select R2 bucket (default for ${data.quality_mode === 'max' ? '💎 max' : '⚡ flex'} is on top):`,
    reply_markup: {
      inline_keyboard: [
        ...bucketButtons,
        [{ text: '+ Create new bucket', callback_data: 'bkt:new' }],
        [cancelButton()],
      ],
    },
  };

  if (messageId) {
    await telegramCall('editMessageText', { ...body, message_id: messageId }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', body, env.CONTROL_BOT_TOKEN);
  }
}

async function handleBucketNameInput(
  chatId: number, userId: number, text: string, data: WizardData, env: Env,
): Promise<void> {
  const name = text.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: 'Invalid bucket name. Use 3–63 lowercase letters, numbers, or hyphens. No leading/trailing hyphens. Try again:',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  const bucketId = generateId();

  // Insert inactive record first — if R2 call fails, we deactivate and retry.
  await insertBucket(env.DB, bucketId, userId, name, name);

  // Non-critical status notification — wrapped so a failed send doesn't abort.
  telegramCall('sendMessage', {
    chat_id: chatId, text: `Creating bucket "${name}"...`,
  }, env.CONTROL_BOT_TOKEN).catch(() => {/* ignore */});

  try {
    const r2Rest = R2Client.forBucket(name, env.R2_ACCOUNT_ID, env.R2_ACCOUNT_TOKEN);
    await r2Rest.createBucket(name, env.R2_ACCOUNT_ID, env.R2_ACCOUNT_TOKEN);
    await activateBucket(env.DB, bucketId);
    logger.info('r2 bucket created', { bucket: name, user_id: userId });
  } catch (err) {
    await deactivateBucket(env.DB, bucketId);
    logger.error('r2 bucket creation failed', {
      bucket: name,
      error: err instanceof Error ? err.message : String(err),
    });
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: `Failed to create bucket "${name}". Try a different name or select an existing bucket.`,
    }, env.CONTROL_BOT_TOKEN);
    await sendBucketStep(chatId, userId, undefined, data, env);
    return;
  }

  data.bucket_id = bucketId;
  await saveSession(env.DB, userId, 'wizard_confirm', data);
  await sendConfirmStep(chatId, data, env);
}

async function handleBucketChoice(
  chatId: number, userId: number, bucketId: string, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  data.bucket_id = bucketId;
  await saveSession(env.DB, userId, 'wizard_confirm', data);
  await sendConfirmStep(chatId, data, env, messageId);
}

async function sendConfirmStep(
  chatId: number, data: WizardData, env: Env, messageId?: number,
): Promise<void> {
  const sizeStr = data.aspect_ratio === 'custom'
    ? `${data.width}×${data.height}`
    : data.aspect_ratio ?? '?';

  const gpuCount = data.gpu_count ?? 1;
  const summary = [
    `Name:     ${data.name}`,
    `Quality:  ${qualityLabel(data.quality_mode ?? 'flex')}`,
    `Videos:   ${data.total_videos}`,
    `Size:     ${sizeStr}`,
    `FPS:      ${data.fps}`,
    `Duration: ${data.duration_secs}s`,
    `Sound:    ${data.sound_enabled ? '🔊 On' : '🔇 Off'}`,
    `GPUs:     ×${gpuCount}`,
  ].join('\n');

  const body = {
    chat_id: chatId,
    text: `Review your stream:\n\n${summary}\n\nLaunch?`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Launch', callback_data: 'confirm:launch' }],
        [cancelButton()],
      ],
    },
  };

  if (messageId) {
    await telegramCall('editMessageText', { ...body, message_id: messageId }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', body, env.CONTROL_BOT_TOKEN);
  }
}

async function handleConfirmLaunch(
  chatId: number, userId: number, data: WizardData, env: Env,
  messageId?: number,
): Promise<void> {
  if (!data.name || !data.total_videos || !data.fps || !data.duration_secs || !data.bucket_id) {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: 'Stream data is incomplete. Starting over.',
    }, env.CONTROL_BOT_TOKEN);
    await resetToIdle(env.DB, userId);
    await sendMainMenu(chatId, env);
    return;
  }

  const streamId = generateId();

  await insertStream(env.DB, {
    id: streamId,
    userId,
    bucketId: data.bucket_id,
    name: data.name,
    totalVideos: data.total_videos,
    aspectRatio: data.aspect_ratio ?? null,
    width: data.width ?? null,
    height: data.height ?? null,
    fps: data.fps,
    durationSecs: data.duration_secs,
    soundEnabled: data.sound_enabled ?? false,
    channelId: env.TELEGRAM_CHANNEL_ID ?? null,
    gpuCount: data.gpu_count ?? 1,
    qualityMode: data.quality_mode ?? 'flex',
  });

  // Launch immediately — the "Launch" button must actually queue the stream, not
  // just leave it as a draft. Previously this only inserted the draft and lied
  // ("Queuing will start shortly"), forcing a second manual Launch from the stream
  // list and leaving phantom drafts. Transition + enqueue exactly like the
  // draft-list Launch path (handleStreamLaunch).
  await transitionStreamToQueued(env.DB, streamId);
  const batchSize = Math.min(
    data.total_videos,
    parseInt(env.PROMPT_BATCH_SIZE ?? '20', 10),
  );
  await enqueueStreamLaunch(env.STREAM_QUEUE, {
    stream_id: streamId,
    user_id: userId,
    batch_index: 0,
    batch_size: batchSize,
    seq_start: 1,
  });

  await resetToIdle(env.DB, userId);

  logger.info('stream created and launched', { stream_id: streamId, user_id: userId, name: data.name, quality_mode: data.quality_mode ?? 'flex' });

  const confirmText = `Stream "${data.name}" launched.\n\nID: ${streamId.slice(0, 8)}...\n\nGenerating ${data.total_videos} prompts and queueing render jobs.`;
  if (messageId) {
    await telegramCall('editMessageText', {
      chat_id: chatId, message_id: messageId, text: confirmText,
    }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', {
      chat_id: chatId, text: confirmText,
    }, env.CONTROL_BOT_TOKEN);
  }

  await sendMainMenu(chatId, env);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cancelButton() {
  return { text: 'Cancel', callback_data: 'wizard:cancel' };
}

/** One place for the operator-facing quality labels — wizard step + confirmation. */
function qualityLabel(mode: 'flex' | 'max'): string {
  return mode === 'max' ? '💎 Max' : '⚡ Flex';
}

async function editMessage(
  chatId: number, messageId: number | undefined, text: string,
  replyMarkup: unknown, env: Env,
): Promise<void> {
  if (messageId) {
    await telegramCall('editMessageText', {
      chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup,
    }, env.CONTROL_BOT_TOKEN);
  } else {
    await telegramCall('sendMessage', {
      chat_id: chatId, text, reply_markup: replyMarkup,
    }, env.CONTROL_BOT_TOKEN);
  }
}

// Max renders 1080p-class: the entire cost case for the mode is "pay ~5× for
// showcase quality", and 24 steps at flex resolution would waste that premium.
// Dimensions stay multiples of 32 (LTX latent constraint) — hence 1088, not 1080.
function arToPixels(ar: string, mode: 'flex' | 'max' = 'flex'): [number, number] {
  // Max = Wan 2.2, a 720p-native model: higher resolutions overrun its training
  // and ~double render time. Multiples of 16 (Wan VAE stride).
  if (mode === 'max') {
    switch (ar) {
      case '9:16':  return [704, 1280];
      case '16:9':  return [1280, 704];
      case '1:1':   return [960, 960];
      default:      return [960, 960];
    }
  }
  switch (ar) {
    case '9:16':  return [576, 1024];
    case '16:9':  return [1024, 576];
    case '1:1':   return [768, 768];
    default:      return [768, 768];
  }
}
