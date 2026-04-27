-- Canonical D1 schema — reference copy.
-- Never apply this file directly. Use migrations in src/db/migrations/.

-- ─── users ────────────────────────────────────────────────────────────────────
-- One row per Telegram user who has authenticated.
CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY,      -- Telegram user_id (stable identifier)
    username         TEXT,                     -- @handle if available
    first_name       TEXT NOT NULL,
    authenticated_at TEXT NOT NULL,            -- ISO-8601 UTC
    is_active        INTEGER NOT NULL DEFAULT 1  -- 0 = access revoked
);

-- ─── buckets ──────────────────────────────────────────────────────────────────
-- R2 buckets the operator has registered or created from the bot.
CREATE TABLE IF NOT EXISTS buckets (
    id          TEXT PRIMARY KEY,              -- UUID v4
    user_id     INTEGER NOT NULL REFERENCES users(id),
    bucket_name TEXT NOT NULL UNIQUE,          -- exact R2 bucket name
    label       TEXT NOT NULL,                 -- human-readable name shown in bot
    created_at  TEXT NOT NULL,                 -- ISO-8601 UTC
    is_active   INTEGER NOT NULL DEFAULT 1
);

-- ─── streams ──────────────────────────────────────────────────────────────────
-- A stream is one configured video generation run (1 to thousands of videos).
-- State machine: draft → queued → running → completed | failed | cancelled
CREATE TABLE IF NOT EXISTS streams (
    id              TEXT PRIMARY KEY,           -- UUID v4
    user_id         INTEGER NOT NULL REFERENCES users(id),
    bucket_id       TEXT NOT NULL REFERENCES buckets(id),
    name            TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft','queued','running','completed','failed','cancelled')),

    -- video parameters
    total_videos    INTEGER NOT NULL,
    aspect_ratio    TEXT,                       -- '9:16' | '16:9' | '1:1' | 'custom'
    width           INTEGER,
    height          INTEGER,
    fps             INTEGER NOT NULL DEFAULT 24,
    duration_secs   INTEGER NOT NULL,
    sound_enabled   INTEGER NOT NULL DEFAULT 0, -- 0 = off, 1 = on

    -- target Telegram channel for publishing
    channel_id      TEXT,

    -- progress counters (updated atomically by queue consumers)
    videos_queued    INTEGER NOT NULL DEFAULT 0,
    videos_rendered  INTEGER NOT NULL DEFAULT 0,
    videos_published INTEGER NOT NULL DEFAULT 0,
    videos_failed    INTEGER NOT NULL DEFAULT 0,

    -- Vast.ai instance tracking
    vast_instance_id TEXT,

    -- timestamps (ISO-8601 UTC, set explicitly by application)
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    completed_at TEXT,

    CONSTRAINT stream_total_positive   CHECK (total_videos > 0),
    CONSTRAINT stream_fps_range        CHECK (fps BETWEEN 1 AND 60),
    CONSTRAINT stream_duration_positive CHECK (duration_secs > 0)
);

CREATE INDEX IF NOT EXISTS idx_streams_user_state ON streams(user_id, state);
CREATE INDEX IF NOT EXISTS idx_streams_state ON streams(state);

-- ─── jobs ─────────────────────────────────────────────────────────────────────
-- One job = one video render + publish cycle within a stream.
-- State machine: pending → rendering → rendered → publishing → published | failed | cancelled
CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,              -- UUID v4
    stream_id    TEXT NOT NULL REFERENCES streams(id),
    user_id      INTEGER NOT NULL REFERENCES users(id),
    sequence_num INTEGER NOT NULL,              -- 1-based position within the stream

    state        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN (
                         'pending','rendering','rendered',
                         'publishing','published','failed','cancelled'
                     )),
    error_message TEXT,                         -- last failure reason (safe, no secrets)

    -- prompt (set when job enters rendering)
    prompt_text        TEXT,
    prompt_fingerprint TEXT,                    -- FK to prompt_fingerprints.fingerprint

    -- render output
    r2_key    TEXT,                             -- R2 object key for the rendered video
    r2_bucket TEXT,                             -- bucket name

    -- publish output
    telegram_message_id TEXT,                   -- Telegram message ID after publish

    -- retry tracking
    render_attempts  INTEGER NOT NULL DEFAULT 0,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,

    -- Vast.ai context for traceability
    vast_instance_id TEXT,

    -- timestamps (ISO-8601 UTC)
    created_at           TEXT NOT NULL,
    render_started_at    TEXT,
    render_completed_at  TEXT,
    publish_started_at   TEXT,
    publish_completed_at TEXT,
    failed_at            TEXT,

    UNIQUE (stream_id, sequence_num)
);

CREATE INDEX IF NOT EXISTS idx_jobs_stream_state ON jobs(stream_id, state);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_vast ON jobs(vast_instance_id);

-- ─── prompt_fingerprints ─────────────────────────────────────────────────────
-- Deduplication index for the prompt pipeline.
-- One row per generated prompt; prevents repeats across active and recent streams.
CREATE TABLE IF NOT EXISTS prompt_fingerprints (
    fingerprint TEXT PRIMARY KEY,               -- deterministic hash of canonical brief fields
    stream_id   TEXT NOT NULL REFERENCES streams(id),
    job_id      TEXT NOT NULL REFERENCES jobs(id),
    created_at  TEXT NOT NULL,                  -- ISO-8601 UTC

    -- structured brief fields for near-duplicate detection (Phase 3)
    theme       TEXT,
    subject     TEXT,
    action      TEXT,
    environment TEXT,
    camera      TEXT
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_stream   ON prompt_fingerprints(stream_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_created  ON prompt_fingerprints(created_at);
