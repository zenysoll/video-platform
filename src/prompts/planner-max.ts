/**
 * Max-mode prompt planner — structured cinematic briefs, rendered server-side.
 *
 * Follows the LTX-2.3 prompt guide (docs/research/max-mode-research-2026-07.md §prompt):
 * Gemini returns strict JSON {subject, action, setting, camera_move, lighting,
 * palette, lens, mood}; the paragraph is assembled HERE, in that field order,
 * 4-8 sentences — never by the LLM. Server-side rendering is what makes the
 * hard rules enforceable: exactly one camera move (validated against a fixed
 * list), a constant style bible per batch, and a negative prompt that lives in
 * workflow-max.json rather than anywhere near the LLM.
 *
 * One Gemini call per prompt, same as flex — the subrequest budget math in
 * wrangler.toml (PROMPT_BATCH_SIZE) holds unchanged.
 */

import { geminiGenerate, type GeminiConfig } from './gemini.js';
import { MAX_AVOID_LABELS_IN_PROMPT, type PromptBrief } from './planner.js';

/**
 * The only camera moves a brief may use — verbatim, exactly one per clip.
 * Multiple or free-form moves are the top source of LTX motion artefacts.
 */
export const MAX_CAMERA_MOVES = [
  'slow dolly-in',
  'tracking shot',
  'crane down',
  'orbital arc',
  'handheld follow',
  'rack focus',
  'push-in',
  'pull-back',
  'whip pan',
] as const;

/**
 * Lighting vocabulary the model is steered toward (research doc: light must
 * agree with the energy of the motion). Adaptation to the scene is allowed;
 * the list anchors word choice away from vague "beautiful lighting" output.
 */
const LIGHTING_VOCAB = [
  'golden hour rim light',
  'chiaroscuro side light',
  'volumetric light shafts',
  'soft overcast diffusion',
  'neon practicals',
  'candlelight flicker',
  'blue hour ambience',
  'tungsten interior warmth',
  'moonlit silver wash',
  'harsh noon sun',
  'backlit silhouette',
  'firelight glow',
];

/**
 * Per-batch style bible — a CONSTANT suffix on every rendered paragraph.
 * Keeps 1000 diverse clips looking like one showcase reel instead of 1000
 * unrelated styles. Changing it is a deliberate product decision, not LLM drift.
 */
export const MAX_STYLE_BIBLE =
  '35mm film, shallow depth of field, fine grain, subtle halation, cinematic color grade';

/** Structured fields Gemini must return for a max-mode clip. */
interface MaxBriefFields {
  subject: string;
  action: string;
  setting: string;
  camera_move: string;
  lighting: string;
  palette: string;
  lens: string;
  mood: string;
}

const MAX_SYSTEM = `You are a cinematography director writing shot briefs for a film-grade text-to-video model.
Generate ONE unique clip concept as structured JSON. A real camera operator must be able to shoot it without asking a single question.

Output ONLY valid JSON, no markdown:
{
  "subject": "ONE concrete subject — detailed noun phrase (appearance, wardrobe, surface texture), 6-14 words",
  "action": "present-tense verb phrase that continues the subject naturally; ONE single physical action, 5-12 words",
  "setting": "prepositional phrase starting with in/on/at/inside/under — concrete place and time of day, 6-14 words",
  "camera_move": "EXACTLY one of: ${MAX_CAMERA_MOVES.join(' | ')}",
  "lighting": "lighting description drawing on: ${LIGHTING_VOCAB.join(', ')} — adapt to the scene, 4-10 words",
  "palette": "dominant colour palette of the frame, 3-8 words",
  "lens": "lens/optics choice, e.g. '85mm prime with creamy bokeh', 3-8 words",
  "mood": "emotional tone, 2-6 words"
}

HARD RULES:
- camera_move MUST be copied verbatim from the list — no variations, no combinations, no second move.
- Lighting must agree with the energy of the action: calm action → soft/static light, kinetic action → hard or dynamic light.
- One subject, one action, one setting. No crowds, no second character in focus.
- NEVER describe on-screen text: no captions, subtitles, signs with readable words, logos, watermarks, screens with UI.
- NEVER state countable quantities of objects or people (no "three", "five", "a dozen" of anything).
- No vague qualifiers (beautiful, stunning, amazing). Concrete nouns, physical verbs, material textures.
- Output JSON only — no extra text.`;

/** Normalise a field: trim, collapse whitespace, drop a trailing period. */
function cleanField(s: string): string {
  return s.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 'an orbital arc' vs 'a slow dolly-in'. */
function article(phrase: string): string {
  return /^[aeiou]/i.test(phrase) ? 'an' : 'a';
}

/**
 * Assemble the final paragraph in the canonical field order
 * (subject → action → setting → camera → lighting → palette → lens → mood),
 * six sentences + the constant style bible. Deterministic: the same fields
 * always render the same paragraph, which keeps fingerprints and the
 * prior-prompt avoid snippets stable across retries.
 */
export function renderMaxParagraph(f: MaxBriefFields): string {
  return [
    `${sentenceCase(f.subject)} ${f.action} ${f.setting}.`,
    `The camera performs ${article(f.camera_move)} ${f.camera_move}, holding the subject in frame.`,
    `${sentenceCase(f.lighting)}, with a palette of ${f.palette}.`,
    `Shot on ${f.lens}.`,
    `The mood is ${f.mood}.`,
    `${sentenceCase(MAX_STYLE_BIBLE)}.`,
  ].join(' ');
}

/**
 * Generate a max-mode brief. Same call shape as generateBrief so pipeline.ts
 * can switch on quality mode without restructuring its reroll loop; any
 * validation failure throws, and the pipeline's existing reroll handles it.
 *
 * The returned PromptBrief maps mood+palette → aesthetic and setting/camera →
 * environment/camera, so fingerprinting, avoid-labels and the D1 row layout
 * all reuse the flex machinery unchanged.
 */
export async function generateMaxBrief(
  avoidThemes: string[],
  streamContext: string,
  config: GeminiConfig,
  priorAvoidThemes: string[] = [],
  creativeAnchors?: string | null,
): Promise<PromptBrief> {
  const mergedAvoid = [...priorAvoidThemes, ...avoidThemes];
  const avoidStr = mergedAvoid.length > 0
    ? `\nAlready used in this stream (DO NOT repeat these subjects/settings/moods or close variants):\n${mergedAvoid.slice(-MAX_AVOID_LABELS_IN_PROMPT).join(', ')}`
    : '';

  const anchorStr = creativeAnchors?.trim()
    ? `\n\nMANDATORY SCENE CONTEXT — the clip MUST be set in this specific environment/situation with this subject. Build the brief concretely around it — do not substitute a generic alternative:\n${creativeAnchors.trim()}`
    : '';

  const userPrompt = `Stream context: ${streamContext || 'general short-form social video'}${avoidStr}${anchorStr}

Generate one unique cinematic clip brief.`;

  const raw = await geminiGenerate(MAX_SYSTEM, userPrompt, {
    ...config,
    temperature: 0.9,
    maxTokens: 768,
    // Disable thinking — structured JSON output doesn't benefit from extended reasoning.
    thinkingBudget: 0,
  });

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let fields: MaxBriefFields;
  try {
    fields = JSON.parse(cleaned) as MaxBriefFields;
  } catch {
    throw new Error(`Max planner returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  const required: (keyof MaxBriefFields)[] = [
    'subject', 'action', 'setting', 'camera_move', 'lighting', 'palette', 'lens', 'mood',
  ];
  for (const key of required) {
    if (!fields[key] || typeof fields[key] !== 'string') {
      throw new Error(`Max planner brief missing field: ${key}`);
    }
    fields[key] = cleanField(fields[key]);
  }

  // Exactly one camera move, verbatim from the fixed list. Anything else is a
  // hallucinated move (or two moves glued together) — reroll rather than render.
  const cameraMove = fields.camera_move.toLowerCase();
  if (!(MAX_CAMERA_MOVES as readonly string[]).includes(cameraMove)) {
    throw new Error(`Max planner camera_move not in fixed list: "${fields.camera_move}"`);
  }
  fields.camera_move = cameraMove;

  return {
    // mood+palette is the closest analogue of flex's aesthetic label — it carries
    // the visual identity into the fingerprint hash and the avoid list.
    aesthetic: `${fields.mood}, ${fields.palette}`,
    subject: fields.subject,
    action: fields.action,
    prompt: renderMaxParagraph(fields),
    environment: fields.setting,
    camera: fields.camera_move,
  };
}
