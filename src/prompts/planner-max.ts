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
import type { QualityMode } from '../config/modes.js';

/**
 * Per-mode trigger prefix prepended to the rendered paragraph.
 *
 * max (the Wan 2.2 pipeline) runs the Instareal LoRA, trained with the literal
 * trigger tokens "Instacam, amateur photo" — the LoRA activates far more
 * reliably from its trigger words than from equivalent natural-language
 * descriptors, and Wan weights the START of the prompt, so the tokens must
 * lead the paragraph. flex carries an empty prefix: its rendered output stays
 * byte-identical (stable fingerprints and avoid-snippets across rollouts).
 */
export const MODE_TRIGGER_PREFIX: Record<QualityMode, string> = {
  flex: '',
  max: 'Instacam, amateur photo, ',
};

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
// v2 note: grain and halation moved OUT of the prompt — the worker's ffmpeg
// film-finish now adds them physically, and prompting for them double-dips.
// "cinematic color grade" is deliberately GONE: live A/B frames showed it pushes
// the model into an oversaturated teal-orange "AI poster" look, while realism
// lives in natural, slightly imperfect color (the flex clip accidentally proved
// this — its flat muted palette read as more real than the graded max output).
export const MAX_STYLE_BIBLE =
  'shot on 35mm film, documentary realism, natural true-to-life colors, shallow depth of field, slightly imperfect exposure';

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

const MAX_SYSTEM = `You are a documentary cinematographer writing shot briefs for a film-grade text-to-video model.
Generate ONE unique clip concept as structured JSON. A real camera operator must be able to shoot it without asking a single question, and a viewer must believe it was FILMED, not generated.

Output ONLY valid JSON, no markdown:
{
  "subject": "ONE concrete LIVING or WORKING subject — a person mid-task, an animal in motion, or a machine doing physical work; detailed noun phrase (appearance, wardrobe, surface texture), 6-14 words",
  "action": "present-tense verb phrase; ONE physical action that VISIBLY CHANGES THE ENVIRONMENT — splashes, footprints, dust kicked up, steam released, sparks, fabric and hair moved by wind or motion, 5-12 words",
  "setting": "prepositional phrase starting with in/on/at/inside/under — concrete place and time of day, INCLUDING a practical light source visible in frame (neon sign, market stall lamp, headlights, fire, window light, welding arc), 8-16 words",
  "camera_move": "EXACTLY one of: ${MAX_CAMERA_MOVES.join(' | ')}",
  "lighting": "lighting description drawing on: ${LIGHTING_VOCAB.join(', ')} — natural and slightly imperfect, adapt to the scene, 4-10 words",
  "palette": "natural true-to-life palette, 3-8 words — muted and believable, NEVER saturated poster colors or teal-orange grading",
  "lens": "lens/optics choice, e.g. '85mm prime with creamy bokeh', 3-8 words",
  "mood": "emotional tone, 2-6 words"
}

SCENE ARCHETYPES — draw scenes from these families (they read as real footage):
street food being cooked at a night market; craftspeople at work (welding, pottery, carpentry, tailoring); animals moving through weather or water; rain, snow, fog or wind interacting with people and streets; markets, harbors, workshops, kitchens and garages lit by their own practical lights; vehicles and machines working (tractors, boats, trains, cranes); water in action — waves, rapids, washing, pouring.

BANNED SCENES (they read as AI): shadows or silhouettes as the main subject; objects floating, hovering or bouncing with no visible cause; static beauty portraits with no action; empty landscapes with slow pans; abstract or decorative compositions; small trivial objects (coins, fruit, bread) without a human working with them.

HARD RULES:
- camera_move MUST be copied verbatim from the list — no variations, no combinations, no second move.
- The subject must physically interact with the environment — the interaction (splash, dust, steam, footprints, sparks) is what makes footage believable. It is REQUIRED, not optional.
- Lighting must agree with the energy of the action: calm action → soft/static light, kinetic action → hard or dynamic light. Prefer imperfect, mixed, practical light over clean studio light.
- One subject, one action, one setting. No crowds in focus, no second character in focus.
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
export function renderMaxParagraph(f: MaxBriefFields, mode: QualityMode = 'max'): string {
  return MODE_TRIGGER_PREFIX[mode] + [
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
  // The only per-mode difference in this planner is the LoRA trigger
  // prefix applied in renderMaxParagraph. Defaults to 'max' so existing call
  // sites keep byte-identical output.
  mode: QualityMode = 'max',
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
    prompt: renderMaxParagraph(fields, mode),
    environment: fields.setting,
    camera: fields.camera_move,
  };
}
