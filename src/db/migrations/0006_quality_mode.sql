-- Migration 0006: per-stream quality mode.
--
-- 'flex' — the current pipeline: LTX-2.3 22B distilled on RTX 5090 (cheap, fast).
-- 'max'  — LTX-2.3 22B dev (non-distilled) on RTX PRO 6000 96GB: 24 steps,
--          CFG 3.5, real negative prompt, showcase-grade output at ~5× cost.
--
-- The value is chosen once in the creation wizard and drives GPU tier selection,
-- checkpoint download, and the ComfyUI workflow. All per-mode infra constants
-- live in src/config/modes.ts — this column only selects between them.

ALTER TABLE streams ADD COLUMN quality_mode TEXT NOT NULL DEFAULT 'flex';
