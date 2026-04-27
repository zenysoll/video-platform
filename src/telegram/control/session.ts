/**
 * Session manager for the control bot.
 *
 * A session tracks whether a user is authenticated and what step of the
 * stream creation wizard they are on. State is persisted in D1.
 *
 * Wizard step flow:
 *   waiting_password
 *   → wizard_name → wizard_total_videos → wizard_aspect_ratio
 *   → (if custom) wizard_custom_width → wizard_custom_height
 *   → wizard_fps → wizard_duration → wizard_sound
 *   → wizard_bucket → (if new) wizard_bucket_name
 *   → wizard_confirm → (done) null (idle)
 */

import { getSession, upsertSession, clearSession } from '../../db/queries.js';

export type WizardStep =
  | 'waiting_password'
  | 'wizard_name'
  | 'wizard_total_videos'
  | 'wizard_aspect_ratio'
  | 'wizard_custom_width'
  | 'wizard_custom_height'
  | 'wizard_fps'
  | 'wizard_duration'
  | 'wizard_sound'
  | 'wizard_gpu_count'
  | 'wizard_bucket'
  | 'wizard_bucket_name'
  | 'wizard_confirm';

export interface WizardData {
  name?: string;
  total_videos?: number;
  aspect_ratio?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration_secs?: number;
  sound_enabled?: boolean;
  gpu_count?: number;
  bucket_id?: string;
  bucket_name_pending?: string;
}

export interface Session {
  isAuthenticated: boolean;
  step: WizardStep | null;
  wizardData: WizardData;
}

export async function loadSession(db: D1Database, userId: number): Promise<Session> {
  const row = await getSession(db, userId);
  if (!row) {
    return { isAuthenticated: false, step: 'waiting_password', wizardData: {} };
  }

  const isAuthenticated = row.step !== 'waiting_password';
  const wizardData: WizardData = row.wizard_data ? JSON.parse(row.wizard_data) as WizardData : {};

  return {
    isAuthenticated,
    step: (row.step as WizardStep | null) ?? null,
    wizardData,
  };
}

export async function saveSession(
  db: D1Database,
  userId: number,
  step: WizardStep | null,
  wizardData: WizardData,
): Promise<void> {
  await upsertSession(db, userId, step, wizardData);
}

export async function markAuthenticated(db: D1Database, userId: number): Promise<void> {
  await upsertSession(db, userId, null, {});
}

export async function resetToIdle(db: D1Database, userId: number): Promise<void> {
  await clearSession(db, userId);
}

export async function startWizard(db: D1Database, userId: number): Promise<void> {
  await upsertSession(db, userId, 'wizard_name', {});
}
