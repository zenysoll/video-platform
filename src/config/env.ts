/**
 * Typed shape of the Cloudflare Worker environment.
 *
 * Every binding, variable, and secret is declared here.
 * Handlers receive `env: Env` and access values only through this interface —
 * never through global variables or process.env.
 */
export interface Env {
  // ── D1 Database ─────────────────────────────────────────────────────────────
  DB: D1Database;

  // ── R2 Buckets ───────────────────────────────────────────────────────────────
  /** Admin/system bucket bound at deploy time. */
  R2_ADMIN: R2Bucket;

  // ── Queues (producers) ───────────────────────────────────────────────────────
  RENDER_QUEUE: Queue;
  PUBLISH_QUEUE: Queue;

  // ── Non-secret environment variables ────────────────────────────────────────
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  CONTROL_BOT_WEBHOOK_PATH: string;
  PUBLISHER_BOT_WEBHOOK_PATH: string;
  VAST_API_BASE_URL: string;
  /** Public HTTPS URL of this Worker — passed to GPU workers as CONTROL_PLANE_URL. */
  CONTROL_PLANE_URL: string;

  // ── Secrets (set via `wrangler secret put`) ──────────────────────────────────
  /** Telegram bot token for the control bot. Never log or forward to workers. */
  CONTROL_BOT_TOKEN: string;
  /** Telegram bot token for the publisher bot. Never log or forward to workers. */
  PUBLISHER_BOT_TOKEN: string;
  /** Webhook secret_token for control bot HMAC verification. */
  CONTROL_BOT_SECRET: string;
  /** Webhook secret_token for publisher bot HMAC verification. */
  PUBLISHER_BOT_SECRET: string;
  /** Vast.ai account API key. Only used inside src/vast/client.ts. */
  VAST_API_KEY: string;
  /** Cloudflare API token scoped to R2 for runtime bucket operations. */
  R2_ACCOUNT_TOKEN: string;
  /** Cloudflare account ID, needed for the R2 REST API base URL. */
  R2_ACCOUNT_ID: string;
  /** Hash of the operator access password (bcrypt-compatible). */
  ACCESS_PASSWORD_HASH: string;
  /** Default Telegram channel ID where the publisher bot posts videos. */
  TELEGRAM_CHANNEL_ID: string;
  /** Google Gemini API key for prompt generation. */
  GEMINI_API_KEY: string;
  /** Gemini model to use (default: gemini-2.0-flash). */
  GEMINI_MODEL: string;
  /** How many prompts to generate per batch (default: "20"; must fit CF subrequests with 2× Gemini per prompt). */
  PROMPT_BATCH_SIZE: string;
  /**
   * Prompt diversity: off | soft | full — deterministic slot hints (see src/prompts/diversity.ts).
   * If unset, stream-consumer treats as soft.
   */
  DIVERSITY_MODE?: string;
  /** Queue for stream launch jobs. */
  STREAM_QUEUE: Queue;
  /** Shared secret between the control plane and GPU workers. Never logged. */
  WORKER_SECRET: string;
  /** HuggingFace access token for downloading gated models (Gemma-3) on GPU workers. */
  HF_TOKEN: string;
  /** R2 model bucket S3-compatible credentials — fast model download on GPU instances.
   *  Create via CF Dashboard: R2 → Manage API Tokens → video-platform-models Object R/W. */
  R2_MODEL_KEY_ID?: string;
  R2_MODEL_SECRET?: string;
  /**
   * Comma-separated Vast.ai machine IDs to permanently exclude from offer selection.
   * Use this to block known-broken hosts (e.g. CDI/GPU injection failures).
   * Example: "36773,12345"
   */
  VAST_EXCLUDED_MACHINES?: string;
  /**
   * Comma-separated Vast.ai HOST IDs to permanently exclude from offer selection.
   *
   * Prefer this over VAST_EXCLUDED_MACHINES: a broken host rotates machine ids
   * (host 402342 served machines 73811 / 91334 / 91308 for the same rig), so a
   * machine-level ban never sticks. Host-level bans are permanent; transient
   * failures are handled automatically by the host_failures cooldown table.
   * Example: "402342,12345"
   */
  VAST_EXCLUDED_HOSTS?: string;
  /**
   * Docker image for GPU workers. Overrides DEFAULT_WORKER_IMAGE in
   * stream-consumer.ts so the image can be rolled forward/back via config.
   * Unset → the ghcr.io pre-built image.
   */
  WORKER_IMAGE?: string;
}
