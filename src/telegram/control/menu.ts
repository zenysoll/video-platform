/**
 * Main menu and shared keyboard helpers for the control bot.
 */

import type { Env } from '../../config/env.js';
import { telegramCall } from '../types.js';

export async function sendMainMenu(chatId: number, env: Env): Promise<void> {
  await telegramCall('sendMessage', {
    chat_id: chatId,
    text: 'Ready. Choose an action.',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'New stream', callback_data: 'action:new_stream' }],
        [{ text: 'My streams', callback_data: 'action:streams' }],
      ],
    },
  }, env.CONTROL_BOT_TOKEN);
}

export async function editToMainMenu(chatId: number, messageId: number, env: Env): Promise<void> {
  await telegramCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: 'Ready. Choose an action.',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'New stream', callback_data: 'action:new_stream' }],
        [{ text: 'My streams', callback_data: 'action:streams' }],
      ],
    },
  }, env.CONTROL_BOT_TOKEN);
}
