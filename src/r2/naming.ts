/**
 * R2 key naming — flat layout, self-describing filename.
 *
 * Format: <job_id>_<WxH>_<fps>_<durationSecs>_<timestampUtc>.mp4
 * Example: 7f3a9c21-4b2e-4f8d-a1c3-9e0d7f2b5a6c_576x1024_24_5_20260419T183345Z.mp4
 *
 * All videos land at the bucket root — no folder hierarchy.
 * Every identity dimension (job, resolution, fps, duration, time) is readable
 * directly from the object name without querying D1.
 *
 * Timestamp is ISO-8601 basic UTC at second precision, recorded at upload time.
 */

export interface R2KeyParams {
  jobId: string;
  width: number;
  height: number;
  fps: number;
  durationSecs: number;
  /** Upload timestamp. Defaults to Date.now() when omitted. */
  uploadedAt?: Date;
}

/**
 * Format a Date as ISO-8601 basic UTC: YYYYMMDDTHHMMSSZ
 */
function toBasicUtc(d: Date): string {
  return d.toISOString()          // "2026-04-19T18:33:45.123Z"
    .replace(/[-:]/g, '')         // "20260419T183345.123Z"
    .replace(/\.\d+Z$/, 'Z');     // "20260419T183345Z"
}

/**
 * Build the flat R2 object key for a rendered video.
 */
export function buildR2Key(params: R2KeyParams): string {
  const ts = toBasicUtc(params.uploadedAt ?? new Date());
  const res = `${params.width}x${params.height}`;
  return `${params.jobId}_${res}_${params.fps}_${params.durationSecs}_${ts}.mp4`;
}
