/**
 * Prompt fingerprinting — deterministic uniqueness key for deduplication.
 *
 * Fingerprint is a SHA-256 hash of the canonical brief fields:
 *   aesthetic + subject + action
 *
 * These three fields carry the visual identity.
 * The final prompt text varies naturally and is excluded to avoid
 * near-duplicate misses when phrasing differs but the concept is the same.
 */

import { sha256Hex } from '../lib/idempotency.js';
import type { PromptBrief } from './planner.js';

/**
 * Compute a deterministic fingerprint for a brief.
 * Normalised to lowercase + trimmed to avoid near-duplicate misses.
 */
export async function computeFingerprint(brief: PromptBrief): Promise<string> {
  const canonical = [
    brief.aesthetic,
    brief.subject,
    brief.action,
  ]
    .map(s => s.toLowerCase().trim().replace(/\s+/g, ' '))
    .join('|');

  return sha256Hex(canonical);
}

/**
 * Check if a fingerprint already exists in D1.
 * Returns true if it's a duplicate.
 */
export async function isDuplicate(
  db: D1Database,
  fingerprint: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM prompt_fingerprints WHERE fingerprint = ?')
    .bind(fingerprint)
    .first();
  return row !== null;
}

/**
 * Persist a fingerprint after a job is successfully assigned a prompt.
 */
export async function saveFingerprint(
  db: D1Database,
  fingerprint: string,
  streamId: string,
  jobId: string,
  brief: PromptBrief,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(`
      INSERT OR IGNORE INTO prompt_fingerprints
        (fingerprint, stream_id, job_id, created_at, theme, subject, action, environment, camera)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    // aesthetic → theme column; environment and camera not in new brief (empty strings — no schema migration needed)
    .bind(fingerprint, streamId, jobId, now, brief.aesthetic, brief.subject, brief.action, '', '')
    .run();
}

const BRIEF_LABEL_MAX = 95;
const PROMPT_SNIPPET_MAX = 130;

function truncate(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function dedupePreserveOrder(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Recent rows from prompt_fingerprints — rich labels for planner avoid-list.
 */
export async function fetchRecentBriefAvoidLabels(
  db: D1Database,
  streamId: string,
  limit: number,
): Promise<string[]> {
  const result = await db
    .prepare(`
      SELECT theme, subject, action, environment FROM prompt_fingerprints
      WHERE stream_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .bind(streamId, limit)
    .all<{
      theme: string | null;
      subject: string | null;
      action: string | null;
      environment: string | null;
    }>();

  const labels: string[] = [];
  for (const row of result.results ?? []) {
    const theme = row.theme?.trim() ?? '';
    const subject = row.subject?.trim() ?? '';
    const action = row.action?.trim() ?? '';
    const env = row.environment?.trim() ?? '';
    if (!theme && !subject) continue;
    const head = [theme, subject].filter(Boolean).join('/');
    const tailParts = [action, env].filter(Boolean);
    let line = tailParts.length > 0 ? `${head} | ${tailParts.join(' · ')}` : head;
    line = truncate(line, BRIEF_LABEL_MAX);
    labels.push(line);
  }
  return labels;
}

/**
 * Short excerpts from prior final prompts — catches same plot, different brief wording.
 */
export async function fetchRecentPromptSnippetsForStream(
  db: D1Database,
  streamId: string,
  limit: number,
): Promise<string[]> {
  const result = await db
    .prepare(`
      SELECT prompt_text FROM jobs
      WHERE stream_id = ? AND prompt_text IS NOT NULL AND LENGTH(TRIM(COALESCE(prompt_text, ''))) > 0
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .bind(streamId, limit)
    .all<{ prompt_text: string | null }>();

  const snippets: string[] = [];
  for (const row of result.results ?? []) {
    const p = row.prompt_text?.trim() ?? '';
    if (!p) continue;
    snippets.push(truncate(p, PROMPT_SNIPPET_MAX));
  }
  return snippets;
}

/**
 * Merged prior avoid list for this stream (briefs + rendered prompt excerpts), deduped.
 */
export async function buildPriorAvoidLabelsForStream(
  db: D1Database,
  streamId: string,
  briefLimit: number,
  snippetLimit: number,
): Promise<string[]> {
  const brief = await fetchRecentBriefAvoidLabels(db, streamId, briefLimit);
  const rawSnips = await fetchRecentPromptSnippetsForStream(db, streamId, snippetLimit);
  const snippets = rawSnips.map(s => `prior clip: ${s}`);
  return dedupePreserveOrder([...brief, ...snippets]);
}
