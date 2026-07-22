/**
 * Control bot update handler.
 *
 * Routing logic:
 * 1. Not authenticated (step = 'waiting_password' or no session) → auth gate
 * 2. Authenticated, callback_query → wizard or action buttons
 * 3. Authenticated, message → command routing or wizard text input
 */

import type { Env } from '../../config/env.js';
import { telegramCall, type TelegramUpdate } from '../types.js';
import { loadSession } from './session.js';
import { handlePasswordAttempt } from './auth.js';
import { handleWizardText, handleWizardCallback, startWizardFlow } from './wizard.js';
import { handleStreamsCommand, handleStatusCommand, handleStatusRefresh, handleStreamLaunch, handleStreamCancel, handleStreamKill } from './commands.js';
import { sendMainMenu } from './menu.js';
import { logger } from '../../lib/logger.js';

export async function handleControlUpdate(
  update: TelegramUpdate,
  env: Env,
): Promise<void> {

  // ── Callback query (button tap) ─────────────────────────────────────────────
  if (update.callback_query) {
    const query = update.callback_query;
    const userId = query.from.id;
    const chatId = query.message?.chat.id;

    // Always ack to remove the spinner.
    await telegramCall('answerCallbackQuery', {
      callback_query_id: query.id,
    }, env.CONTROL_BOT_TOKEN).catch(() => null);

    if (!chatId) return;

    const session = await loadSession(env.DB, userId);
    if (!session.isAuthenticated) {
      await telegramCall('sendMessage', {
        chat_id: chatId,
        text: 'Session expired. Send your password to log in again.',
      }, env.CONTROL_BOT_TOKEN);
      return;
    }

    const data = query.data ?? '';

    if (data === 'action:new_stream') {
      await startWizardFlow(chatId, userId, env);
      return;
    }

    if (data === 'action:streams') {
      await handleStreamsCommand(chatId, userId, env);
      return;
    }

    if (data === 'status:refresh') {
      await handleStatusRefresh(chatId, userId, query.message?.message_id, env);
      return;
    }

    // Stream launch / cancel from draft list.
    if (data.startsWith('stream:launch:')) {
      await handleStreamLaunch(chatId, userId, data.slice(14), query.message?.message_id, env);
      return;
    }
    if (data.startsWith('stream:cancel:')) {
      await handleStreamCancel(chatId, userId, data.slice(14), query.message?.message_id, env);
      return;
    }
    if (data.startsWith('stream:kill:')) {
      await handleStreamKill(chatId, userId, data.slice(12), query.message?.message_id, env);
      return;
    }

    // Wizard button — delegate to wizard handler.
    if (session.step?.startsWith('wizard_') || data.startsWith('wizard:') || data.startsWith('confirm:')) {
      await handleWizardCallback(query, env);
      return;
    }

    // Inline buttons from wizard steps (qm:, ar:, fps:, dur:, snd:, bkt:, tvid:, gpu:)
    const wizardPrefixes = ['qm:', 'ar:', 'fps:', 'dur:', 'snd:', 'bkt:', 'tvid:', 'gpu:'];
    if (wizardPrefixes.some(p => data.startsWith(p))) {
      await handleWizardCallback(query, env);
      return;
    }

    logger.debug('unhandled callback', { data, user_id: userId });
    return;
  }

  // ── Message ──────────────────────────────────────────────────────────────────
  const message = update.message;
  if (!message) return;

  const userId = message.from?.id;
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? '';

  if (!userId) return;

  const session = await loadSession(env.DB, userId);

  // Not authenticated — treat any text as password attempt.
  if (!session.isAuthenticated) {
    await handlePasswordAttempt(message, env);
    return;
  }

  // Authenticated — handle commands first.
  if (text === '/start' || text === '/menu') {
    await sendMainMenu(chatId, env);
    return;
  }

  if (text === '/streams') {
    await handleStreamsCommand(chatId, userId, env);
    return;
  }

  if (text === '/status') {
    await handleStatusCommand(chatId, userId, env);
    return;
  }

  // In wizard — forward text to wizard handler.
  if (session.step?.startsWith('wizard_')) {
    await handleWizardText(message, env);
    return;
  }

  // Idle, unrecognized text → show menu.
  await sendMainMenu(chatId, env);
}
