/**
 * Prompt pipeline orchestrator.
 *
 * Generates a batch of unique, validated prompts for a stream.
 * Each prompt goes through: plan → render → validate → fingerprint → persist.
 *
 * Single Gemini call per prompt: the planner now returns a complete brief
 * including the final prompt paragraph. The renderer is a passthrough.
 *
 * Deduplication: fingerprints are checked against D1 before accepting a prompt.
 * Reroll policy: up to MAX_REROLLS attempts per job slot before giving up.
 *
 * The pipeline returns only fully accepted prompts.
 * Caller is responsible for creating job records and enqueueing render jobs.
 */

import { generateBrief, type PromptBrief } from './planner.js';
import { generateMaxBrief } from './planner-max.js';
import { renderPrompt } from './renderer.js';
import { validatePrompt, validateLength, validateMaxLength } from './validator.js';
import { computeFingerprint, isDuplicate, saveFingerprint } from './fingerprint.js';
import { parseDiversityMode, stableSlotHints } from './diversity.js';
import type { GeminiConfig } from './gemini.js';
import type { QualityMode } from '../config/modes.js';
import { logger } from '../lib/logger.js';

const MAX_REROLLS = 4;

/** Rich in-batch avoid: aesthetic / subject / action (truncated). */
function briefSlotAvoidLabel(brief: { aesthetic: string; subject: string; action: string }): string {
  const a = brief.action.trim().replace(/\s+/g, ' ');
  const actionShort = a.length > 72 ? `${a.slice(0, 71)}…` : a;
  return `${brief.aesthetic.trim()}/${brief.subject.trim()}/${actionShort}`;
}

export interface PromptBatchMeta {
  streamId: string;
  batchIndex: number;
  seqStart: number;
  /** Raw env string; parsed with parseDiversityMode. */
  diversityMode: string;
  /**
   * Stream quality mode — 'max' switches to the structured cinematic planner
   * (planner-max.ts), which also prepends the Wan LoRA trigger prefix.
   * Fingerprinting, dedup and rerolls are identical in all modes; only the
   * brief generator and the length window differ.
   */
  qualityMode?: QualityMode;
}

/**
 * Returns true for errors that mean the Gemini service itself is down.
 * On these errors we bail out of the whole batch immediately to avoid
 * burning through the CF Workers subrequest budget on retries that will
 * all fail anyway (503 storm / "Too many subrequests" cascade).
 */
function isTransientOutage(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('429') ||          // quota / rate-limit — retrying immediately won't help
    msg.includes('Too many subrequests')
  );
}

export interface GeneratedPrompt {
  brief: PromptBrief;
  promptText: string;
  fingerprint: string;
}

/**
 * Generate `count` unique prompts for a stream.
 *
 * @param count            Number of prompts to generate in this batch.
 * @param durationSecs     Video duration — passed to renderer (passthrough).
 * @param streamContext    Free-text context about the stream's style/topic.
 * @param db               D1 database for fingerprint dedup checks.
 * @param geminiConfig     Gemini API configuration.
 * @param priorAvoidLabels Merged avoid labels from D1 (fingerprint rows + prior prompt snippets).
 * @param batchMeta        Stream id, batch index, seq start, diversity mode for deterministic slot hints.
 */
export async function generatePromptBatch(
  count: number,
  durationSecs: number,
  streamContext: string,
  db: D1Database,
  geminiConfig: GeminiConfig,
  priorAvoidLabels: string[] = [],
  batchMeta?: PromptBatchMeta,
): Promise<GeneratedPrompt[]> {
  const results: GeneratedPrompt[] = [];
  // Track aesthetics used in this batch to guide the planner.
  const usedThemes: string[] = [];
  // Set to true on first 503/unavailable to bail out fast and preserve
  // the CF Workers subrequest budget for a later retry.
  let serviceOutage = false;

  const diversityMode = batchMeta ? parseDiversityMode(batchMeta.diversityMode) : parseDiversityMode('off');
  const qualityMode: QualityMode = batchMeta?.qualityMode ?? 'flex';
  // max rides the structured-brief planner path (server-rendered
  // paragraph, max length window) — it differs only by the LoRA trigger prefix
  // that generateMaxBrief applies when passed the mode.
  const usesMaxPlanner = qualityMode === 'max';

  for (let i = 0; i < count; i++) {
    if (serviceOutage) break;
    let accepted: GeneratedPrompt | null = null;

    // Merge plannerLines + rendererFrameEmphasis into a single creativeAnchors string
    // for the merged single-call planner (renderer is now a passthrough).
    let creativeAnchors: string | null = null;
    if (batchMeta && diversityMode !== 'off') {
      const hints = await stableSlotHints(
        batchMeta.streamId,
        batchMeta.batchIndex,
        batchMeta.seqStart + i,
        diversityMode,
      );
      if (hints) {
        const parts = [hints.plannerLines, hints.rendererFrameEmphasis].filter(Boolean);
        creativeAnchors = parts.join(' ');
      }
    }

    for (let attempt = 0; attempt < MAX_REROLLS; attempt++) {
      let brief: PromptBrief;
      try {
        // Same call shape in all modes — the max planner throws on any
        // structural violation (bad JSON, off-list camera move) and lands in
        // the same reroll path as a flex parse failure.
        brief = usesMaxPlanner
          ? await generateMaxBrief(
              usedThemes,
              streamContext,
              geminiConfig,
              priorAvoidLabels,
              creativeAnchors,
              qualityMode,
            )
          : await generateBrief(
              usedThemes,
              streamContext,
              geminiConfig,
              priorAvoidLabels,
              creativeAnchors,
            );
      } catch (err) {
        if (isTransientOutage(err)) {
          logger.warn('planner: transient outage detected, bailing batch', { attempt, error: String(err) });
          serviceOutage = true;
          break;
        }
        logger.warn('planner failed', { attempt, error: String(err) });
        continue;
      }

      const fingerprint = await computeFingerprint(brief);

      // Dedup check against D1 and current batch
      if (await isDuplicate(db, fingerprint)) {
        logger.debug('fingerprint duplicate in DB, rerolling', { attempt });
        continue;
      }
      if (results.some(r => r.fingerprint === fingerprint)) {
        logger.debug('fingerprint duplicate in batch, rerolling', { attempt });
        continue;
      }

      // renderPrompt is now a passthrough — returns brief.prompt, no Gemini call.
      let promptText: string;
      try {
        promptText = await renderPrompt(brief, durationSecs, geminiConfig);
      } catch (err) {
        if (isTransientOutage(err)) {
          logger.warn('renderer: transient outage detected, bailing batch', { attempt, error: String(err) });
          serviceOutage = true;
          break;
        }
        logger.warn('renderer failed', { attempt, error: String(err) });
        continue;
      }

      const lengthCheck = usesMaxPlanner
        ? validateMaxLength(promptText)
        : validateLength(promptText);
      if (!lengthCheck.ok) {
        logger.warn('prompt length invalid, rerolling', { reason: lengthCheck.reason, attempt, words: promptText.split(/\s+/).filter(Boolean).length, preview: promptText.slice(0, 120) });
        continue;
      }

      const qualityCheck = validatePrompt(promptText);
      if (!qualityCheck.ok) {
        logger.warn('prompt quality rejected, rerolling', { reason: qualityCheck.reason, attempt, preview: promptText.slice(0, 120) });
        continue;
      }
      if (qualityCheck.reason) {
        logger.debug('prompt quality warning', { reason: qualityCheck.reason });
      }

      accepted = { brief, promptText, fingerprint };
      usedThemes.push(briefSlotAvoidLabel(brief));
      break;
    }

    if (accepted) {
      results.push(accepted);
    } else {
      logger.warn('prompt generation failed after max rerolls', { slot: i, max_rerolls: MAX_REROLLS });
      // Skip this slot — stream will have fewer videos than requested.
    }
  }

  logger.info('prompt batch complete', {
    requested: count,
    accepted: results.length,
    skipped: count - results.length,
    service_outage: serviceOutage,
  });

  // If Gemini was unavailable, throw immediately so CF Queues retries the
  // whole batch without silently dropping prompts.
  if (serviceOutage) {
    throw new Error('Gemini transient outage — CF Queues will retry this batch');
  }

  return results;
}

/**
 * Save accepted prompts to D1 (fingerprints table) after jobs are created.
 * Called after job IDs are known.
 */
export async function persistPromptFingerprints(
  db: D1Database,
  prompts: GeneratedPrompt[],
  streamId: string,
  jobIds: string[],
): Promise<void> {
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const jobId = jobIds[i];
    if (!p || !jobId) continue;
    await saveFingerprint(db, p.fingerprint, streamId, jobId, p.brief);
  }
}
