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
  workflowFile: 'workflow.json' | 'workflow-max.json';
  /** R2 key of the model checkpoint bootstrap downloads for this mode. */
  checkpointR2Key: string;
}

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
    checkpointR2Key: 'checkpoints/ltx-2.3-22b-distilled-1.1.safetensors',
  },
  max: {
    // RTX PRO 6000 comes as a workstation ('WS') and a server ('S') SKU —
    // same 96 GB Blackwell silicon, so either runs the bf16 dev checkpoint.
    gpuTiers: ['RTX PRO 6000 WS', 'RTX PRO 6000 S'],
    minGpuRamGb: 90,   // dev ckpt is bf16 ~42 GB on disk, ~80+ GB resident
    minCpuRamGb: 48,
    diskGb: 170,       // 42 GB dev ckpt + 9 GB Gemma + ComfyUI + buffer
    maxDph: 2.5,       // keeps 1000-video batches inside the ≤5×-flex budget
    workerImage: GHCR_WORKER_IMAGE,
    bootstrapMode: 'max',
    workflowFile: 'workflow-max.json',
    checkpointR2Key: 'checkpoints/ltx-2.3-22b-dev.safetensors',
  },
};

/**
 * Normalise a raw DB/query value to a QualityMode.
 * Unknown or missing values fall back to 'flex' so a pre-migration row (or a
 * bad manual edit) degrades to the known-good pipeline instead of crashing.
 */
export function parseQualityMode(raw: string | null | undefined): QualityMode {
  return raw === 'max' ? 'max' : 'flex';
}
