-- Host-level failure memory.
--
-- Why: VAST_EXCLUDED_MACHINES bans by machine_id, but a broken Vast.ai *host*
-- rotates machine ids (host 402342 served machines 73811 / 91334 / 91308 for the
-- same physical rig). Machine-level bans therefore never stick, and because offer
-- search is `dph_total asc` + offers[0], the cheapest broken host wins every retry
-- forever. This table remembers the host so re-provisioning picks a different one.
--
-- Rows are written by the reaper when it recycles a stalled instance and read by
-- the stream consumer during offer search. Entries expire after a cooldown window
-- (see HOST_FAILURE_COOLDOWN_H) rather than being deleted immediately, so a host
-- that is rate-limited by Docker Hub (6h window) is skipped until it recovers.

-- Which host a stream's instance was provisioned on, so the reaper knows what to
-- blame when that instance stalls.
ALTER TABLE streams ADD COLUMN vast_host_id INTEGER;

CREATE TABLE IF NOT EXISTS host_failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id    INTEGER NOT NULL,
  machine_id INTEGER,
  -- 'stuck-loading' (docker pull wedged) | 'alive-but-dead' (no render progress)
  reason     TEXT    NOT NULL,
  stream_id  TEXT,
  failed_at  TEXT    NOT NULL
);

-- Read pattern: "hosts that failed since <cutoff>" → index the cutoff column.
CREATE INDEX IF NOT EXISTS idx_host_failures_failed_at ON host_failures(failed_at);
CREATE INDEX IF NOT EXISTS idx_host_failures_host_id   ON host_failures(host_id);
