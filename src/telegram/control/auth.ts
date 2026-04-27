/**
 * Authentication gate for the control bot.
 *
 * First interaction: user sends any text → treated as password attempt.
 * Correct password → user record created/updated in D1, session set to idle.
 * Wrong password → no information about correctness (generic message).
 */

import type { Env } from '../../config/env.js';
import type { TelegramMessage } from '../types.js';
import { telegramCall } from '../types.js';
import { verifyPassword } from '../../lib/password.js';
import { upsertUser } from '../../db/queries.js';
import { markAuthenticated } from './session.js';
import { logger } from '../../lib/logger.js';
import { sendMainMenu } from './menu.js';

export async function handlePasswordAttempt(
  message: TelegramMessage,
  env: Env,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const candidate = message.text?.trim() ?? '';

  if (!userId) return;

  const valid = await verifyPassword(candidate, env.ACCESS_PASSWORD_HASH);

  if (!valid) {
    logger.info('failed password attempt', { user_id: userId });
    await telegramCall('sendMessage', {
      chat_id: chatId,
      text: 'Incorrect password. Try again.',
    }, env.CONTROL_BOT_TOKEN);
    return;
  }

  // Authenticated — persist user and session.
  await upsertUser(env.DB, userId, message.from?.first_name ?? 'Operator', message.from?.username ?? null);
  await markAuthenticated(env.DB, userId);

  logger.info('user authenticated', { user_id: userId });

  await sendMainMenu(chatId, env);
}
