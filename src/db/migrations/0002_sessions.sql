-- Migration 0002: add sessions table for Telegram bot conversation state

CREATE TABLE IF NOT EXISTS sessions (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id),
    -- Wizard step the user is currently on.
    -- NULL means authenticated and idle (no active wizard).
    step        TEXT CHECK (step IN (
                    'waiting_password',
                    'wizard_name',
                    'wizard_total_videos',
                    'wizard_aspect_ratio',
                    'wizard_custom_width',
                    'wizard_custom_height',
                    'wizard_fps',
                    'wizard_duration',
                    'wizard_sound',
                    'wizard_gpu_count',
                    'wizard_bucket',
                    'wizard_bucket_name',
                    'wizard_confirm'
                )),
    -- JSON blob of in-progress wizard data.
    wizard_data TEXT,
    -- ISO-8601 UTC
    updated_at  TEXT NOT NULL
);
