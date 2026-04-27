/**
 * Typed D1 query helpers.
 *
 * All database access goes through these functions — no raw SQL in handlers.
 * Timestamps are always ISO-8601 UTC strings set explicitly by the application.
 */

import { nowIso } from '../lib/idempotency.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DbUser {
  id: number;
  username: string | null;
  first_name: string;
  authenticated_at: string;
  is_active: number;
}

export interface DbSession {
  user_id: number;
  step: string | null;
  wizard_data: string | null;
  updated_at: string;
}

export interface DbBucket {
  id: string;
  user_id: number;
  bucket_name: string;
  label: string;
  created_at: string;
  is_active: number;
}

export interface DbStream {
  id: string;
  user_id: number;
  bucket_id: string;
  name: string;
  state: string;
  total_videos: number;
  aspect_ratio: string | null;
  width: number | null;
  height: number | null;
  fps: number;
  duration_secs: number;
  sound_enabled: number;
  channel_id: string | null;
  videos_queued: number;
  videos_rendered: number;
  videos_published: number;
  videos_failed: number;
  vast_instance_id: string | null;
  gpu_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function getUser(db: D1Database, userId: number): Promise<DbUser | null> {
  return db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<DbUser>();
}

export async function upsertUser(
  db: D1Database,
  userId: number,
  firstName: string,
  username: string | null,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO users (id, first_name, username, authenticated_at, is_active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        first_name = excluded.first_name,
        username = excluded.username,
        authenticated_at = excluded.authenticated_at,
        is_active = 1
    `)
    .bind(userId, firstName, username, nowIso())
    .run();
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function getSession(db: D1Database, userId: number): Promise<DbSession | null> {
  return db
    .prepare('SELECT * FROM sessions WHERE user_id = ?')
    .bind(userId)
    .first<DbSession>();
}

export async function upsertSession(
  db: D1Database,
  userId: number,
  step: string | null,
  wizardData: unknown,
): Promise<void> {
  const dataJson = wizardData !== null ? JSON.stringify(wizardData) : null;
  await db
    .prepare(`
      INSERT INTO sessions (user_id, step, wizard_data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        step = excluded.step,
        wizard_data = excluded.wizard_data,
        updated_at = excluded.updated_at
    `)
    .bind(userId, step, dataJson, nowIso())
    .run();
}

export async function clearSession(db: D1Database, userId: number): Promise<void> {
  await upsertSession(db, userId, null, null);
}

// ── Buckets ───────────────────────────────────────────────────────────────────

export async function getBucketsForUser(db: D1Database, userId: number): Promise<DbBucket[]> {
  const result = await db
    .prepare('SELECT * FROM buckets WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC')
    .bind(userId)
    .all<DbBucket>();
  return result.results;
}

export async function getBucket(db: D1Database, bucketId: string): Promise<DbBucket | null> {
  return db
    .prepare('SELECT * FROM buckets WHERE id = ? AND is_active = 1')
    .bind(bucketId)
    .first<DbBucket>();
}

export async function insertBucket(
  db: D1Database,
  id: string,
  userId: number,
  bucketName: string,
  label: string,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO buckets (id, user_id, bucket_name, label, created_at, is_active)
      VALUES (?, ?, ?, ?, ?, 0)
    `)
    .bind(id, userId, bucketName, label, nowIso())
    .run();
}

export async function activateBucket(db: D1Database, bucketId: string): Promise<void> {
  await db
    .prepare('UPDATE buckets SET is_active = 1 WHERE id = ?')
    .bind(bucketId)
    .run();
}

export async function deactivateBucket(db: D1Database, bucketId: string): Promise<void> {
  await db
    .prepare('UPDATE buckets SET is_active = 0 WHERE id = ?')
    .bind(bucketId)
    .run();
}

// ── Streams ───────────────────────────────────────────────────────────────────

export interface InsertStreamParams {
  id: string;
  userId: number;
  bucketId: string;
  name: string;
  totalVideos: number;
  aspectRatio: string | null;
  width: number | null;
  height: number | null;
  fps: number;
  durationSecs: number;
  soundEnabled: boolean;
  channelId: string | null;
  gpuCount?: number;
}

export async function insertStream(db: D1Database, p: InsertStreamParams): Promise<void> {
  await db
    .prepare(`
      INSERT INTO streams (
        id, user_id, bucket_id, name, state,
        total_videos, aspect_ratio, width, height,
        fps, duration_secs, sound_enabled, channel_id,
        videos_queued, videos_rendered, videos_published, videos_failed,
        gpu_count, created_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
    `)
    .bind(
      p.id, p.userId, p.bucketId, p.name,
      p.totalVideos, p.aspectRatio, p.width, p.height,
      p.fps, p.durationSecs, p.soundEnabled ? 1 : 0, p.channelId,
      p.gpuCount ?? 1,
      nowIso(),
    )
    .run();
}

export async function getStreamsForUser(db: D1Database, userId: number): Promise<DbStream[]> {
  const result = await db
    .prepare(`
      SELECT * FROM streams WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 10
    `)
    .bind(userId)
    .all<DbStream>();
  return result.results;
}

export async function getActiveStreamsForUser(db: D1Database, userId: number): Promise<DbStream[]> {
  const result = await db
    .prepare(`
      SELECT * FROM streams
      WHERE user_id = ? AND state IN ('queued', 'running')
      ORDER BY created_at DESC
    `)
    .bind(userId)
    .all<DbStream>();
  return result.results;
}

export async function getDraftStreamsForUser(db: D1Database, userId: number): Promise<DbStream[]> {
  const result = await db
    .prepare(`
      SELECT * FROM streams WHERE user_id = ? AND state = 'draft'
      ORDER BY created_at DESC LIMIT 5
    `)
    .bind(userId)
    .all<DbStream>();
  return result.results;
}

export async function getStream(db: D1Database, streamId: string): Promise<DbStream | null> {
  return db
    .prepare('SELECT * FROM streams WHERE id = ?')
    .bind(streamId)
    .first<DbStream>();
}

export async function transitionStreamToQueued(db: D1Database, streamId: string): Promise<void> {
  await db
    .prepare(`UPDATE streams SET state = 'queued' WHERE id = ? AND state = 'draft'`)
    .bind(streamId)
    .run();
}

export async function cancelStream(db: D1Database, streamId: string): Promise<void> {
  await db
    .prepare(`UPDATE streams SET state = 'cancelled', completed_at = ? WHERE id = ? AND state IN ('draft','queued')`)
    .bind(nowIso(), streamId)
    .run();
}

/**
 * Force-kill a stream regardless of its current state.
 * Works on running/queued streams (unlike cancelStream which only handles draft/queued).
 * Also cancels all pending/rendering jobs so they don't get picked up by new workers.
 */
export async function forceKillStream(db: D1Database, streamId: string): Promise<void> {
  await db
    .prepare(`UPDATE streams SET state = 'cancelled', completed_at = ? WHERE id = ? AND state NOT IN ('completed', 'cancelled')`)
    .bind(nowIso(), streamId)
    .run();

  await db
    .prepare(`UPDATE jobs SET state = 'cancelled' WHERE stream_id = ? AND state IN ('pending', 'rendering')`)
    .bind(streamId)
    .run();
}
