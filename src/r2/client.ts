/**
 * R2 storage client.
 *
 * Two modes of operation:
 *
 * 1. Binding-based (R2Client): uses the Cloudflare Workers R2Bucket binding.
 *    For the admin bucket (env.R2_ADMIN) only — fast, no credentials needed.
 *
 * 2. REST API-based (R2RestClient): uses the Cloudflare S3-compatible API.
 *    For operator-created runtime buckets that cannot be added as wrangler bindings.
 *    Requires R2_ACCOUNT_TOKEN and R2_ACCOUNT_ID secrets.
 *
 * Security: account token is only used inside R2RestClient methods, never logged.
 */

import { logger } from '../lib/logger.js';

// ── Mode 1: binding-based ────────────────────────────────────────────────────

export class R2Client {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: ReadableStream | ArrayBuffer | string): Promise<void> {
    await this.bucket.put(key, body);
    logger.debug('r2 put', { key });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
    logger.debug('r2 delete', { key });
  }

  async listPrefix(prefix: string): Promise<R2Object[]> {
    const result = await this.bucket.list({ prefix });
    return result.objects;
  }

  /** Factory for runtime operator buckets via the REST API. */
  static forBucket(
    bucketName: string,
    accountId: string,
    token: string,
  ): R2RestClient {
    return new R2RestClient(bucketName, accountId, token);
  }
}

// ── Mode 2: REST API-based ───────────────────────────────────────────────────

export class R2RestClient {
  private readonly baseUrl: string;

  constructor(
    private readonly bucketName: string,
    private readonly accountId: string,
    private readonly token: string,
  ) {
    // Use the Cloudflare REST API (not S3-compatible endpoint) so Bearer token auth works
    // without needing AWS Signature v4 or x-amz-content-sha256 headers.
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`;
  }

  async put(key: string, body: string | ArrayBuffer | ReadableStream, contentType = 'application/octet-stream'): Promise<void> {
    // Encode each path segment individually, preserving '/' as path separators.
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const url = `${this.baseUrl}/${encodedKey}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': contentType,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new R2RestError('put', response.status, key, text.slice(0, 200));
    }

    logger.debug('r2 rest put', { bucket: this.bucketName, key });
  }

  async delete(key: string): Promise<void> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const url = `${this.baseUrl}/${encodedKey}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` },
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '');
      throw new R2RestError('delete', response.status, key, text.slice(0, 200));
    }

    logger.debug('r2 rest delete', { bucket: this.bucketName, key });
  }

  /**
   * Generate a presigned PUT URL for direct upload from a GPU worker.
   *
   * The URL is time-limited and scoped to one key — safe to pass in job payloads.
   * Presigned URL generation requires the S3-compatible API with valid credentials.
   *
   * NOTE: Full presigned URL implementation (AWS SigV4) is added in Phase 4
   * when GPU workers need to upload directly. This stub is here so the method
   * signature is stable.
   */
  /**
   * Create a new R2 bucket via the Cloudflare API.
   *
   * Uses POST /accounts/{accountId}/r2/buckets — not the S3 API.
   * accountId and token are passed explicitly (not from constructor) because
   * R2RestClient is normally scoped to a single bucket.
   */
  async createBucket(bucketName: string, accountId: string, token: string): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: bucketName }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new R2RestError('createBucket', response.status, bucketName, text.slice(0, 200));
    }

    logger.info('r2 bucket created via API', { bucket: bucketName });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async presignedPutUrl(_key: string, _expiresInSeconds = 3600): Promise<string> {
    throw new Error('presignedPutUrl not yet implemented — coming in Phase 4');
  }
}

export class R2RestError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly key: string,
    public readonly detail: string,
  ) {
    super(`R2 REST error on ${operation} key="${key}": ${detail} (HTTP ${status})`);
    this.name = 'R2RestError';
  }
}
