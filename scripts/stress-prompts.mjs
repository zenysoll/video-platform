/**
 * Gemini prompt uniqueness stress tester.
 * Does not simulate production slot diversity (src/prompts/diversity.ts) or D1 prior-avoid.
 *
 * Usage:
 *   GEMINI_API_KEY=<key> node scripts/stress-prompts.mjs [total] [concurrency]
 *
 * Defaults: total=1000, concurrency=10
 *
 * Reports:
 *   - Total generated, unique fingerprints, collision rate
 *   - Empty/invalid briefs (schema failures)
 *   - Gemini error rate
 *   - p50/p95 latency
 */

import { createHash } from 'node:crypto';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
const BASE_URL       = 'https://generativelanguage.googleapis.com/v1beta/models';
const TOTAL          = parseInt(process.argv[2] ?? '1000', 10);
const CONCURRENCY    = parseInt(process.argv[3] ?? '10', 10);

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY env var required');
  process.exit(1);
}

// Keep in sync with src/prompts/planner.ts SYSTEM prompt.
const SYSTEM = `You are a creative director specialising in short-form social video (TikTok / Reels / Shorts).
Your job is to produce a structured brief for one AI-generated video clip.

Rules:
- One clear subject, one readable action.
- Rotate variety: everyday realism, different settings (home, street, gym, cafe, transit, nature, workplace), times of day, and shot moods. Do NOT default to the same archetype (e.g. repeated "cinematic rooftop at night" or generic influencer tropes).
- Prefer believable social-native framing: phone-style vertical energy, handheld or simple tripod, one focal action — not Hollywood epic or trailer voiceover scenes.
- Environments must be vivid but not crowded.
- Camera language must be specific (angle, movement) but not contradictory.
- No extra limbs, no overloaded scenes, no simultaneous conflicting instructions.
- Avoid surreal anatomy or impossible physics.
- The brief must be unique: avoid common, overused themes and anything listed as already used.

Output ONLY valid JSON, no markdown, no explanation. Schema:
{
  "theme": string,
  "subject": string,
  "action": string,
  "environment": string,
  "lighting": string,
  "camera": string,
  "pace": string,
  "hook": string
}`;

const REQUIRED_FIELDS = ['theme', 'subject', 'action', 'environment', 'lighting', 'camera', 'pace', 'hook'];

function fingerprint(brief) {
  const canonical = [brief.theme, brief.subject, brief.action, brief.camera]
    .map(s => s.toLowerCase().trim().replace(/\s+/g, ' '))
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

async function generateOne(avoidThemes, idx) {
  const avoidStr = avoidThemes.length > 0
    ? `\nAlready used in this stream (DO NOT repeat these theme/subject pairs or close variants):\n${avoidThemes.slice(-40).join(', ')}`
    : '';
  const userPrompt = `Stream context: general short-form social video${avoidStr}\n\nGenerate one unique video brief.`;

  const url = `${BASE_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.95,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const latency = Date.now() - t0;

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 120)}`, latency, idx };
  }

  const data = await resp.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let brief;
  try {
    brief = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: `invalid JSON: ${cleaned.slice(0, 80)}`, latency, idx };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!brief[field] || typeof brief[field] !== 'string') {
      return { ok: false, error: `missing field: ${field}`, latency, idx };
    }
  }

  return { ok: true, brief, fingerprint: fingerprint(brief), latency, idx };
}

async function runPool(tasks, concurrency) {
  const results = [];
  const iter = tasks[Symbol.iterator]();
  let done = 0;

  async function worker() {
    for (const task of iter) {
      const r = await task();
      results.push(r);
      done++;
      if (done % 50 === 0) {
        process.stdout.write(`  … ${done}/${tasks.length}\n`);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log(`\n🔬 Stress test: ${TOTAL} prompts, concurrency=${CONCURRENCY}, model=${GEMINI_MODEL}\n`);

const usedThemes = [];
const tasks = Array.from({ length: TOTAL }, (_, i) => () => generateOne(usedThemes, i));

const results = await runPool(tasks, CONCURRENCY);

// Collect used themes as we go (approximate — race-y but fine for avoidance hinting)
for (const r of results) {
  if (r.ok) usedThemes.push(`${r.brief.theme}/${r.brief.subject}`);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const successes   = results.filter(r => r.ok);
const failures    = results.filter(r => !r.ok);
const fps         = new Set(successes.map(r => r.fingerprint));
const latencies   = successes.map(r => r.latency).sort((a, b) => a - b);
const p50         = latencies[Math.floor(latencies.length * 0.50)] ?? 0;
const p95         = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const collisions  = successes.length - fps.size;
const errorRate   = (failures.length / TOTAL * 100).toFixed(2);
const collisionPct= successes.length > 0 ? (collisions / successes.length * 100).toFixed(3) : '0.000';
const uniquePct   = successes.length > 0 ? ((fps.size / successes.length) * 100).toFixed(3) : '0.000';

console.log('\n─────────────────────────────────────────');
console.log(`Total requested  : ${TOTAL}`);
console.log(`Successes        : ${successes.length}`);
console.log(`Failures (errors): ${failures.length}  (${errorRate}%)`);
console.log(`Unique FPs       : ${fps.size}`);
console.log(`Collisions       : ${collisions}  (${collisionPct}%)`);
console.log(`Uniqueness rate  : ${uniquePct}%`);
console.log(`Latency p50/p95  : ${p50}ms / ${p95}ms`);
console.log('─────────────────────────────────────────');

if (failures.length > 0) {
  console.log('\nFirst 5 failures:');
  failures.slice(0, 5).forEach(f => console.log(`  [${f.idx}] ${f.error}`));
}

// ── Pass/fail ─────────────────────────────────────────────────────────────────

const PASS_MIN_UNIQUE_PCT  = 99.5;
const PASS_MAX_ERROR_PCT   = 1.0;

const passUnique = parseFloat(uniquePct) >= PASS_MIN_UNIQUE_PCT || successes.length === 0;
const passErrors = parseFloat(errorRate) <= PASS_MAX_ERROR_PCT;

console.log('\n🎯 Pass criteria:');
console.log(`  Uniqueness ≥ ${PASS_MIN_UNIQUE_PCT}% : ${passUnique ? '✅ PASS' : '❌ FAIL'} (${uniquePct}%)`);
console.log(`  Error rate ≤ ${PASS_MAX_ERROR_PCT}%  : ${passErrors ? '✅ PASS' : '❌ FAIL'} (${errorRate}%)`);

if (passUnique && passErrors) {
  console.log('\n✅ OVERALL: PASS\n');
  process.exit(0);
} else {
  console.log('\n❌ OVERALL: FAIL\n');
  process.exit(1);
}
