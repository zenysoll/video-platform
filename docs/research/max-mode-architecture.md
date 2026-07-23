# Max mode — architecture (decided 2026-07-22)

## Product contract
Wizard gains ONE new first step: quality mode — ⚡ Flex (current) | 💎 Max.
Everything else (duration 3-10s, fps, sound on/off, aspect, channel) unchanged.
1000-video batches must stay diverse but look showcase-grade (Runway/Veo3 reel feel).
Budget ceiling: ≤5× flex ≈ $50-75 per 1000 videos.

## Pipeline decision (grounded in docs/research/max-mode-research-2026-07.md)
Two candidates from research; build order chosen by PRODUCT COVERAGE, not raw rank:

**Candidate A — ship first: LTX-2.3 22B dev (non-distilled) on RTX PRO 6000 WS 96GB**
Why first: covers the ENTIRE product surface natively — sound toggle (native AV,
only open model with single-pass audio), 3-10s durations, all aspects; and it is
operationally a CONFIG CHANGE from flex: same ComfyUI-LTXVideo nodes, same Gemma
encoder, same cu128 Blackwell image (RTX PRO 6000 = sm_120 → existing CUDA gate
passes untouched). Settings: 20-28 steps, CFG 3.5, real negative prompt, 1080p-class
resolution, native fps. Est. $50-100/1000 (benchmark will verify; 1080p keeps it in
budget). Risk: LOW.

**Candidate B — challenger, build after A works: Wan 2.2 cinematic stack on 5090**
Research's #1 cinematic look ($27-53/1000) but 5 components (dual-expert + lightx2v
LoRA hybrid-CFG + SeedVR2/FlashVSR SR + RIFE + HunyuanVideo-Foley for sound) and
5s-native (>7s needs routing anyway → cannot cover product alone). Benchmark
head-to-head vs A on golden prompts; winner becomes the max default, loser stays as
config fallback.

## Infra changes (branch max-mode)
1. **Migration 0006**: `ALTER TABLE streams ADD COLUMN quality_mode TEXT NOT NULL DEFAULT 'flex'`.
2. **Wizard** (src/telegram/control/wizard.ts): new FIRST step "Quality" with two
   inline buttons ⚡ Flex / 💎 Max → stores quality_mode; all later steps untouched.
   /status shows 💎 badge for max streams.
3. **Mode config map** (new src/config/modes.ts), consumed by stream-consumer:
   - flex: current constants (5090, min_vram 30, image ghcr comfyui-ltx:cu128,
     bootstrap-models.sh, workflow.json, disk 120, max_dph 1.0)
   - max: gpu_name tiers ["RTX PRO 6000 WS", "RTX PRO 6000 S"], min_gpu_ram 90,
     same ghcr image, MODE=max env for bootstrap (downloads dev ckpt), workflow-max.json,
     disk 170, max_dph 2.5
   All reliability/host-benching/IP-benching logic REUSED unchanged (it is mode-independent).
4. **Bootstrap** (bootstrap-models.sh): honor MODE env — max downloads
   checkpoints/ltx-2.3-22b-dev.safetensors (~42GB) instead of distilled; same Gemma;
   CUDA gate unchanged.
5. **Worker workflow**: serve /worker/workflow.json?mode=max → workflow-max.json
   (steps 24, cfg 3.5, negative prompt const, higher res table per aspect).
   worker.py passes ?mode from its MODE env when fetching.
6. **Prompts** (src/prompts/): max template per research §4 — Gemini returns
   structured JSON {subject, action, setting, camera_move, lighting, palette, lens,
   mood}; render to ONE paragraph 4-8 sentences; per-batch style bible constant;
   exactly one camera move; negative prompt is a SERVER-SIDE constant, never generated.
   Dedupe on field combos (reuses prompt_fingerprints).
7. **R2**: upload ltx-2.3-22b-dev.safetensors to models bucket (from live instance
   during testing; combine with ENAM migration — task #6).

## Verification gate before merge to main
- Benchmark matrix: golden prompts × {A on 6000 Pro} × {3/5/10 s}, wall-clock per
  stage, $/video (then × {B} when built).
- Quality: side-by-side vs flex output; bar = "operator prefers max in ≥80% pairs".
- Full existing test suite (run_tests.sh 9/9) must stay green — mode must not break flex.
- Live: 1 single-video stream → then 3-5 video stream → then merge.

## AMENDMENT 2026-07-23: LTX-dev tier killed, max = Wan 2.2
Operator verdict on live output: LTX-2.3 dev (even with the two-stage plan ahead)
was visually indistinguishable from flex at ~3× the GPU price. The LTX-dev tier is
removed; **'max' is now the Wan 2.2 dual-expert + Instareal pipeline on RTX 5090**
(formerly 'max2', which survives only as a DB/env legacy alias). Product returns
to the original two-tier shape: ⚡ Flex / 💎 Max.
