/**
 * Minimal typed subset of the Telegram Bot API.
 *
 * Only fields actually used in this project are declared.
 * Full Telegram API docs: https://core.telegram.org/bots/api
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  video?: TelegramVideo;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_size?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Incoming update from Telegram. Only used update types are listed. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  channel_post?: TelegramMessage;
  edited_message?: TelegramMessage;
}

// ── Telegram API call helper ─────────────────────────────────────────────────

/**
 * Call any Telegram Bot API method.
 *
 * The bot token is never logged — it is concatenated inside the URL only.
 * Returns the parsed response body, or throws TelegramApiError on failure.
 */
export async function telegramCall<T>(
  method: string,
  body: Record<string, unknown>,
  token: string,
): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json() as { ok: boolean; result?: T; description?: string };

  if (!data.ok) {
    throw new TelegramApiError(method, response.status, data.description ?? 'unknown error');
  }

  return data.result as T;
}

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    public readonly description: string,
  ) {
    super(`Telegram API error on ${method}: ${description} (HTTP ${status})`);
    this.name = 'TelegramApiError';
  }
}
