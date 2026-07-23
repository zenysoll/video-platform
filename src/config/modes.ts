/**
 * Quality-mode infra profiles — single source of truth.
 *
 * A stream's quality_mode (D1 column, set once in the wizard) selects one of
 * these profiles. Everything that differs between flex and max lives here:
 * GPU tiers, hardware minimums, budget ceiling, checkpoint, workflow file.
 * Everything that is mode-INDEPENDENT (reliability floor, inet_down floor,
 * CUDA gate, host/IP benching) stays in stream-consumer.ts and is reused
 * unchanged by both modes.
 *
 * Decision record: docs/research/max-mode-architecture.md.
 */

// 'max' IS the Wan 2.2 pipeline. The LTX-dev tier that briefly occupied this
// slot was killed by operator verdict (2026-07-23): visually indistinguishable
// from flex at ~3× the GPU price. 'max2' survives only as a legacy alias — DB
// rows and one live instance were provisioned under that name.
export type QualityMode = 'flex' | 'max';

export interface ModeConfig {
  /**
   * GPU names tried in order (Vast.ai uses spaces in GPU names).
   * Tier N+1 is only searched when tier N returns zero in-budget offers.
   */
  gpuTiers: string[];
  /** Minimum GPU VRAM in GB, with safety margin vs off-by-one float reporting. */
  minGpuRamGb: number;
  /** Minimum system RAM in GB — one machine regardless of GPU count. */
  minCpuRamGb: number;
  /** Disk allocation in GB: checkpoint + Gemma + ComfyUI + workspace buffer. */
  diskGb: number;
  /**
   * Budget ceiling in $/hr, filtered client-side (Vast.ai search has no
   * max-price operator we rely on). Keeps a thin supply pool from silently
   * selling us a $6/hr box during an outage.
   */
  maxDph: number;
  /**
   * Docker image for GPU workers. Both modes share the same ghcr.io image —
   * max is a checkpoint + workflow change, not a stack change (same ComfyUI
   * LTX nodes, same Gemma encoder, same cu128 Blackwell wheels; RTX PRO 6000
   * is sm_120 like the 5090, so the CUDA gate passes untouched).
   *
   * NOT Docker Hub: anonymous Docker Hub pulls are rate-limited per source IP,
   * and multi-tenant Vast hosts share one egress IP — ghcr.io is unmetered.
   * Overridable per-deploy via the WORKER_IMAGE var in wrangler.toml.
   */
  workerImage: string;
  /** Value exported as MODE in the instance onstart env — read by bootstrap-models.sh. */
  bootstrapMode: QualityMode;
  /** Which workflow the control plane serves for /worker/workflow.json?mode=… */
  workflowFile: 'workflow.json' | 'workflow-wan.json';
}
// NOTE: the checkpoint each mode downloads is derived from MODE inside
// bootstrap-models.sh (a served shell script cannot read this record). Do not
// re-add a checkpoint field here — two sources of truth that merely agree today
// will silently diverge on the next rename.

// Built from ./Dockerfile by .github/workflows/build-worker-image.yml.
// Bakes torch cu128 + ComfyUI + LTX nodes, so bootstrap only fetches weights.
const GHCR_WORKER_IMAGE = 'ghcr.io/zenysoll/comfyui-ltx:cu128';

export const MODES: Record<QualityMode, ModeConfig> = {
  flex: {
    gpuTiers: ['RTX 5090'],
    minGpuRamGb: 30,   // RTX 5090 = 32 GB
    minCpuRamGb: 48,   // cheapest 5090 hosts report ~64 GB as 64009 MB
    diskGb: 120,       // 46 GB distilled ckpt + 9 GB Gemma + ComfyUI + buffer
    maxDph: 1.0,
    workerImage: GHCR_WORKER_IMAGE,
    bootstrapMode: 'flex',
    workflowFile: 'workflow.json',
  },
  max: {
    // Wan 2.2 T2V dual-expert (14B high-noise + 14B low-noise, fp8) on flex
    // hardware: the experts run sequentially, so each fits a 32 GB RTX 5090.
    gpuTiers: ['RTX 5090'],
    minGpuRamGb: 30,   // RTX 5090 = 32 GB; fp8 expert ~14 GB resident at a time
    minCpuRamGb: 48,
    diskGb: 140,       // 2×14 GB experts + 6.7 GB UMT5 + VAE + loras + buffer
    maxDph: 1.0,       // same 5090 pool and budget ceiling as flex
    workerImage: GHCR_WORKER_IMAGE,
    bootstrapMode: 'max',
    workflowFile: 'workflow-wan.json',
  },
};

/**
 * Normalise a raw DB/query value to a QualityMode.
 * Unknown or missing values fall back to 'flex' so a pre-migration row (or a
 * bad manual edit) degrades to the known-good pipeline instead of crashing.
 */
export function parseQualityMode(raw: string | null | undefined): QualityMode {
  // 'max2' is the legacy name of the Wan tier — existing DB rows and any
  // still-running instance (its worker fetches ?mode=max2) must keep resolving
  // to the Wan pipeline, so the alias maps to 'max' rather than falling to flex.
  if (raw === 'max' || raw === 'max2') return 'max';
  return 'flex';
}
