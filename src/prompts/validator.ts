/**
 * Prompt validator — rejects or flags prompts that are likely to produce bad output.
 *
 * Runs synchronously (no LLM call) for speed.
 * The expensive LLM validator pass can be added in a later phase if needed.
 */

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Patterns that correlate with bad LTX-2.3 outputs. */
const REJECT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // Catches hands/fingers/POV as the OPENING subject (prompt must start with subject+action).
    // Anchored to start of string — only rejects when hands/POV IS the primary concept.
    pattern: /^(a\s+)?(pair\s+of\s+)?hands?\b|^(a\s+)?fingers?\b|^\bpov\b|^point[\s-]of[\s-]view\b/i,
    reason: 'hands or POV as primary subject — over-represented trope, rerolling',
  },
  {
    pattern: /\b(multiple|several|many|crowd|group of [3-9]|people everywhere)\b/i,
    reason: 'crowded scene — too many subjects',
  },
  {
    pattern: /\b(six|seven|eight|nine|ten|\d\d+)\s+(people|persons|figures|hands|arms|legs)\b/i,
    reason: 'too many body parts or figures',
  },
  {
    pattern: /\b(zoom in|zoom out).{0,20}(pan|tilt|dolly|track)\b/i,
    reason: 'contradictory camera instructions',
  },
  {
    pattern: /\b(slow.?motion|slowmo).{0,20}(fast.?pace|rapid|quick)\b/i,
    reason: 'contradictory pace instructions',
  },
  {
    pattern: /\b(dancing|fighting|running).{0,30}(while|and).{0,30}(dancing|fighting|running)\b/i,
    reason: 'simultaneous conflicting actions',
  },
];

const WARN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(beautiful|stunning|amazing|gorgeous|incredible)\b/i,
    reason: 'vague qualifiers',
  },
  {
    pattern: /\b(hands?|fingers?).{0,20}(holding|touching|grasping)\b/i,
    reason: 'hand/finger detail — anatomy risk',
  },
];

export function validatePrompt(promptText: string): ValidationResult {
  for (const { pattern, reason } of REJECT_PATTERNS) {
    if (pattern.test(promptText)) {
      return { ok: false, reason: `rejected: ${reason}` };
    }
  }

  // Warn patterns don't reject — they just get logged by the pipeline.
  const warnings = WARN_PATTERNS
    .filter(({ pattern }) => pattern.test(promptText))
    .map(({ reason }) => reason);

  if (warnings.length > 0) {
    // Return ok but caller can log warnings
    return { ok: true, reason: `warnings: ${warnings.join('; ')}` };
  }

  return { ok: true };
}

/** Word count guard — prompts target 20-25 words; 60 is a generous reroll ceiling. */
export function validateLength(promptText: string): ValidationResult {
  const words = promptText.split(/\s+/).filter(Boolean).length;
  if (words < 15) return { ok: false, reason: `too short (${words} words)` };
  if (words > 60) return { ok: false, reason: `too long (${words} words)` };
  return { ok: true };
}
