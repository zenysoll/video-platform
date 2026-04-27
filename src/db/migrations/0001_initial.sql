-- Migration 0001: initial schema
-- Applied via: pnpm db:migrate:local  (local)
--              pnpm db:migrate         (remote)

-- ─── users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY,
    username         TEXT,
    first_name       TEXT NOT NULL,
    authenticated_at TEXT NOT NULL,
    is_active        INTEGER NOT NULL DEFAULT 1
);

-- ─── buckets ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buckets (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    bucket_name TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1
);

-- ─── streams ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS streams (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    bucket_id       TEXT NOT NULL REFERENCES buckets(id),
    name            TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft','queued','running','completed','failed','cancelled')),
    total_videos    INTEGER NOT NULL,
    aspect_ratio    TEXT,
    width           INTEGER,
    height          INTEGER,
    fps             INTEGER NOT NULL DEFAULT 24,
    duration_secs   INTEGER NOT NULL,
    sound_enabled   INTEGER NOT NULL DEFAULT 0,
    channel_id      TEXT,
    videos_queued    INTEGER NOT NULL DEFAULT 0,
    videos_rendered  INTEGER NOT NULL DEFAULT 0,
    videos_published INTEGER NOT NULL DEFAULT 0,
    videos_failed    INTEGER NOT NULL DEFAULT 0,
    vast_instance_id TEXT,
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    completed_at TEXT,
    CONSTRAINT stream_total_positive    CHECK (total_videos > 0),
    CONSTRAINT stream_fps_range         CHECK (fps BETWEEN 1 AND 60),
    CONSTRAINT stream_duration_positive CHECK (duration_secs > 0)
);

CREATE INDEX IF NOT EXISTS idx_streams_user_state ON streams(user_id, state);
CREATE INDEX IF NOT EXISTS idx_streams_state ON streams(state);

-- ─── jobs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    stream_id    TEXT NOT NULL REFERENCES streams(id),
    user_id      INTEGER NOT NULL REFERENCES users(id),
    sequence_num INTEGER NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN (
                         'pending','rendering','rendered',
                         'publishing','published','failed','cancelled'
                     )),
    error_message TEXT,
    prompt_text        TEXT,
    prompt_fingerprint TEXT,
    r2_key    TEXT,
    r2_bucket TEXT,
    telegram_message_id TEXT,
    render_attempts  INTEGER NOT NULL DEFAULT 0,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    vast_instance_id TEXT,
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
CREATE TABLE IF NOT EXISTS prompt_fingerprints (
    fingerprint TEXT PRIMARY KEY,
    stream_id   TEXT NOT NULL REFERENCES streams(id),
    job_id      TEXT NOT NULL REFERENCES jobs(id),
    created_at  TEXT NOT NULL,
    theme       TEXT,
    subject     TEXT,
    action      TEXT,
    environment TEXT,
    camera      TEXT
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_stream  ON prompt_fingerprints(stream_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_created ON prompt_fingerprints(created_at);
