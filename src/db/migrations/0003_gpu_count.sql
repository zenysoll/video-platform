-- Migration 0003: add gpu_count to streams
-- gpu_count was added to the streams table after the initial migration
-- but was never captured in a migration file. This backfills it.

ALTER TABLE streams ADD COLUMN gpu_count INTEGER NOT NULL DEFAULT 1;
