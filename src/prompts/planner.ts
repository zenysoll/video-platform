/**
 * Prompt planner — generates a complete video prompt in a single Gemini call.
 *
 * The brief contains an aesthetic label, subject, action, and a ready-to-use
 * prompt paragraph. One Gemini call per prompt (down from 2) halves quota burn
 * and enables batch_size=44 within the CF Workers subrequest budget.
 *
 * Storing structured fields (aesthetic, subject, action) enables near-duplicate
 * fingerprinting across batches.
 */

import { geminiGenerate, type GeminiConfig } from './gemini.js';

export interface PromptBrief {
  aesthetic: string;  // 2-4 word aesthetic label, e.g. "dark academia moody"
  subject: string;    // main subject, 3-5 words
  action: string;     // what happens, 3-5 words
  prompt: string;     // FINAL ready-to-use video prompt, 20-25 words
  // Max-mode extras (planner-max.ts). Persisted into the prompt_fingerprints
  // environment/camera columns so the avoid-list sees setting-level repeats.
  // Absent in flex briefs — the fingerprint hash itself stays aesthetic|subject|action
  // in BOTH modes, so flex fingerprints are byte-identical to before.
  environment?: string;
  camera?: string;
}

/** Max avoid labels passed to Gemini (prior batches + current batch) to cap prompt size. */
export const MAX_AVOID_LABELS_IN_PROMPT = 88;

const SYSTEM = `You are a creative director for a short-form social video platform.
Generate ONE unique video clip concept in a strong, distinct aesthetic/vibe.
The vibe must be FELT through word choice, colour, texture, mood — not stated literally.

Output ONLY valid JSON, no markdown:
{
  "aesthetic": "2-4 word aesthetic label",
  "subject": "main subject in 3-5 words",
  "action": "what happens in 3-5 words",
  "prompt": "complete video prompt in 20-25 words"
}

AESTHETIC PALETTE — pick one per video, rotate widely across the full palette, never repeat:

Visual styles: anime cel-shaded, oil painting impasto, watercolour wash, pixel 8-bit retro,
glitch digital, film noir b&w, 35mm grain texture, neon photography, macro close-up world,
drone birds-eye, infrared glow, duotone graphic, lomography vignette, holographic iridescent,
tilt-shift miniature, cyanotype blueprint blue, cross-process film, double exposure ghost,
solarized pop art, xerography zine rough, sepia daguerreotype, kinetic motion blur,
stark clinical white, deep shadow chiaroscuro, pastel risograph print, grain heavy documentary,
thermal heat-map, wet plate collodion, platinum print silver

Social moods: dark academia moody, cottagecore golden hour, vaporwave purple haze,
cyberpunk rain-slick, barbiecore hot-pink, gorpcore wilderness, Y2K chrome nostalgia,
coastal grandmother, cozy lo-fi bedroom, ethereal slow-motion, punk raw energy,
kawaii bouncy pastel, brutalist concrete grey, carnival chaos, ASMR satisfying texture,
hyperpop saturated, editorial fashion cold, nature documentary patient, horror practical,
absurdist comedy, oldcore nostalgic warmth, weirdcore dreamlike surreal, liminal spaces eerie,
solarpunk hopeful green, normcore everyday plain, bluecore muted desaturated, twee soft indie,
scene emo high contrast, mcbling 2000s chrome, gloomy sunday grey quiet,
grandpacore antique cozy, craftcore handmade texture, goblincore mossy earthy,
maximalist print clashing, minimalist white void, surfer bleached denim, skatepark concrete raw,
underground club dark, rooftop golden dusk, protest street graphic, fairycore iridescent soft,
dark romance velvet, clean girl beige neutral, quiet luxury linen, mob wife maximalist fur

Cultural aesthetics: bollywood vibrant, harajuku street tokyo, scandinavian minimal,
afrofuturist, retro soviet poster, mediterranean bleached, latin tropical, wabi-sabi imperfect,
bauhaus geometry, americana roadside, city pop tokyo 80s, french new wave grain,
south asian maximalist, east african bright fabric, nordic dark winter, k-pop idol polished bright,
chinese ink brush monochrome, greek cyclades white blue, persian ornate tile,
indigenous earth pigment, afro-caribbean festive cotton, balkan embroidery folk,
central american painted wood, slavic birch forest, west african ankara print,
korean hanbok silk elegant, vietnamese lacquer crimson, ethiopian bold geometric,
moroccan zellige mosaic, georgian mountain stone rustic, thai temple gilded gold,
ukrainian embroidery folk colour, argentinian tango shadow, portuguese azulejo blue,
hungarian paprika warmth, mali mud cloth pattern

Environment aesthetics: underwater blue silence, desert heat shimmer, arctic snow stillness,
jungle canopy diffused green, cave mineral dark drip, volcanic obsidian raw,
fog coastal grey soft, midnight urban neon puddle, golden wheat field open,
stormy sky dramatic silver, springtime bloom petal soft, winter bare branch stark

Era aesthetics: 1950s chrome diner gleam, 1970s earth tone wallpaper, 1980s neon pastel synth,
1990s grunge flannel raw, early 2010s instagram saturated, silent film silver flicker,
retro 8mm home movie warm, future chrome minimal cold

FORBIDDEN PRIMARY SUBJECTS — massively over-represented in social video training data.
NEVER use these as the main concept unless the mandatory scene context explicitly requires it:
- hands or fingers as the primary visual subject (hand texture, finger pointing, palms close-up)
- generic POV walking, running, or scrolling perspective
- a phone screen or social media feed as the main visual focus
- a talking head face with no meaningful environment context
- abstract colour gradient with no concrete subject or action

PROMPT RULES:
- Aesthetic must be FELT, not named (don't write "in vaporwave style" — write what makes it feel that way)
- One subject + one action + one environment only. No crowd scenes.
- Exactly 20-25 words. Present tense, active voice.
- No camera directions. No vague words (beautiful, stunning, amazing, cinematic).
- Never mention AI, render, video, or style names literally.
- Output JSON only — no extra text.`;

/**
 * Generate a structured brief (with ready-to-use prompt) for a single video.
 *
 * @param avoidThemes      aesthetic/subject/action labels already used in the current batch.
 * @param streamContext    Optional context about the stream (e.g. target audience, style).
 * @param config           Gemini API configuration.
 * @param priorAvoidThemes labels from earlier batches of this stream (D1).
 * @param creativeAnchors  Mandatory scene/subject/composition constraints for this slot.
 */
export async function generateBrief(
  avoidThemes: string[],
  streamContext: string,
  config: GeminiConfig,
  priorAvoidThemes: string[] = [],
  creativeAnchors?: string | null,
): Promise<PromptBrief> {
  const mergedAvoid = [...priorAvoidThemes, ...avoidThemes];
  const avoidStr = mergedAvoid.length > 0
    ? `\nAlready used in this stream (DO NOT repeat these aesthetics/subjects or close variants):\n${mergedAvoid.slice(-MAX_AVOID_LABELS_IN_PROMPT).join(', ')}`
    : '';

  const anchorStr = creativeAnchors?.trim()
    ? `\n\nMANDATORY SCENE CONTEXT — the video MUST be set in this specific environment/situation with this subject. Build your aesthetic, action, and final prompt concretely around it — do not substitute a generic alternative:\n${creativeAnchors.trim()}`
    : '';

  const userPrompt = `Stream context: ${streamContext || 'general short-form social video'}${avoidStr}${anchorStr}

Generate one unique video brief.`;

  const raw = await geminiGenerate(SYSTEM, userPrompt, {
    ...config,
    temperature: 0.9,
    maxTokens: 512,
    // Disable thinking — structured JSON output doesn't benefit from extended reasoning.
    thinkingBudget: 0,
  });

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let brief: PromptBrief;
  try {
    brief = JSON.parse(cleaned) as PromptBrief;
  } catch {
    throw new Error(`Planner returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  // Basic shape validation
  const required: (keyof PromptBrief)[] = ['aesthetic', 'subject', 'action', 'prompt'];
  for (const key of required) {
    if (!brief[key] || typeof brief[key] !== 'string') {
      throw new Error(`Planner brief missing field: ${key}`);
    }
  }

  return brief;
}
