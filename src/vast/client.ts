/**
 * Vast.ai REST client.
 *
 * Provides four operations: searchOffers, startInstance, getInstance, destroyInstance.
 *
 * Security rules:
 * - API key is concatenated inside this module only; never logged or forwarded.
 * - Non-2xx responses throw VastApiError with a safe message (no credential echo).
 *
 * Retry policy:
 * - No retries inside this client — retries are the responsibility of queue consumers.
 *
 * Cost rule:
 * - destroyInstance uses DELETE (permanent destroy), never stop.
 *   Stopped instances continue billing on Vast.ai.
 */

import { logger } from '../lib/logger.js';
import { VastApiError, type VastInstance, type VastOffer, type VastSearchQuery, type VastStartConfig } from './types.js';

export class VastClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  /**
   * Search available GPU offers.
   *
   * Defaults: only rentable offers, sorted by lowest hourly cost, limit 20.
   * Callers can override any field via the query parameter.
   *
   * Fallback GPU selection: prefer RTX 5090, fall back to any GPU with
   * sufficient VRAM/RAM/disk when the caller filters by minimums.
   *
   * Unit notes (Vast.ai API):
   *   gpu_ram   — returned in MB; min_gpu_ram query param is in GB → multiplied by 1024
   *   cpu_ram   — returned in MB; min_cpu_ram query param is in GB → multiplied by 1024
   *   disk_space — returned in GB; min_disk_space query param is in GB → no conversion
   */
  async searchOffers(query: VastSearchQuery = {}): Promise<VastOffer[]> {
    // NOTE: 'order' and 'limit' must be top-level URL params, NOT inside the JSON q string.
    // Placing them inside q causes Vast.ai to return {"success": false} with 0 results.
    const params: Record<string, unknown> = {
      rentable: { eq: true },
    };

    if (query.gpu_name) {
      params['gpu_name'] = { eq: query.gpu_name };
    }
    if (query.min_gpu_ram !== undefined) {
      // API field gpu_ram is in MB; caller passes GB
      params['gpu_ram'] = { gte: query.min_gpu_ram * 1024 };
    }
    if (query.min_cpu_ram !== undefined) {
      // API field cpu_ram is in MB; caller passes GB.
      // Use 900 instead of 1024 to avoid rounding issues — e.g. cheapest RTX 5090
      // reports cpu_ram=64009 MB (~62.5 GB), which a strict 64*1024=65536 would exclude.
      params['cpu_ram'] = { gte: query.min_cpu_ram * 900 };
    }
    if (query.min_disk_space !== undefined) {
      params['disk_space'] = { gte: query.min_disk_space };
    }
    if (query.min_reliability !== undefined) {
      params['reliability2'] = { gte: query.min_reliability };
    }
    if (query.min_inet_down !== undefined) {
      // inet_down is in Mbps (e.g. 500 = 500 Mbps ≈ 60 MB/s)
      params['inet_down'] = { gte: query.min_inet_down };
    }
    if (query.num_gpus !== undefined) {
      params['num_gpus'] = { eq: query.num_gpus };
    }

    const limit = query.limit ?? 20;

    // Vast.ai API v0 breaking change (2026-05): order and limit must now be inside the q JSON,
    // not as separate URL params. order format changed to [["field", "dir"]] tuple array.
    // Old (broken): ?order=dph_total+asc&limit=10&q=...
    // New (working): ?q={"order":[["dph_total","asc"]],"limit":10,...}
    const orderStr = query.order ?? 'dph_total asc';
    const [orderField, orderDir = 'asc'] = orderStr.split(' ');
    params['order'] = [[orderField, orderDir]];
    params['limit'] = limit;

    const url = `${this.baseUrl}/search/asks/?q=${encodeURIComponent(JSON.stringify(params))}`;
    const response = await this.request('GET', url, undefined, 'searchOffers');

    const data = response as { offers?: VastOffer[] };
    let offers = data.offers ?? [];

    // Client-side country exclusion: Vast.ai geolocation ends with ", XX" (ISO country code).
    // CN datacenters report high local inet_down but have poor Cloudflare R2 throughput.
    if (query.excluded_countries && query.excluded_countries.length > 0) {
      const excluded = query.excluded_countries.map(c => `, ${c.toUpperCase()}`);
      offers = offers.filter(o => !excluded.some(suffix => o.geolocation?.endsWith(suffix)));
      logger.debug('vast offers after country filter', {
        excluded: query.excluded_countries,
        remaining: offers.length,
      });
    }

    return offers;
  }

  /**
   * Start an on-demand instance from an offer ID.
   *
   * Returns the created instance. The instance will be in 'created' or 'loading'
   * state immediately — callers must poll getInstance until status is 'running'.
   *
   * Uses on-demand instances, not spot/interruptible, for production reliability.
   */
  async startInstance(offerId: number, config: VastStartConfig): Promise<VastInstance> {
    const body: Record<string, unknown> = {
      client_id: 'me',
      image: config.image,
      disk: config.disk ?? 100,
      runtype: 'ssh_proxy',
      onstart: config.onstart,
      label: config.label,
    };

    // env vars are embedded in onstart command — extra_env is not used.

    const url = `${this.baseUrl}/asks/${offerId}/`;
    const response = await this.request('PUT', url, body, 'startInstance') as Record<string, unknown>;

    // PUT /asks/{id}/ returns {"new_contract": <instance_id>}, not a full VastInstance.
    // Fetch the full instance object so callers get a consistent type.
    const instanceId = response['new_contract'] as number;
    if (!instanceId) {
      throw new VastApiError('startInstance', 0, `unexpected response — no new_contract field: ${JSON.stringify(response)}`);
    }

    logger.info('vast instance starting', {
      offer_id: offerId,
      instance_id: instanceId,
      label: config.label,
    });

    return this.getInstance(instanceId);
  }

  /**
   * Get the current state of a running instance.
   *
   * Retries up to 5 times with 2-second delay — a freshly created instance may not
   * be immediately visible via GET (Vast.ai propagation lag after PUT /asks/{id}/).
   */
  async getInstance(instanceId: number, retries = 5): Promise<VastInstance> {
    const url = `${this.baseUrl}/instances/${instanceId}/`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await this.request('GET', url, undefined, 'getInstance');

      // GET /instances/{id}/ returns {"instances": <single object>}, NOT an array.
      // GET /instances/ (list) returns {"instances": [...]}.
      // Handle both shapes defensively.
      const raw = response as { instances?: VastInstance | VastInstance[] };
      const instance: VastInstance | undefined = Array.isArray(raw.instances)
        ? raw.instances[0]
        : (raw.instances as VastInstance | undefined);

      if (instance) return instance;

      // Instance not found yet — might be propagation lag. Retry with backoff.
      if (attempt < retries) {
        logger.debug('getInstance: instance not found yet, retrying', {
          instance_id: instanceId,
          attempt: attempt + 1,
          retries,
        });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    throw new VastApiError('getInstance', 404, `instance ${instanceId} not found after ${retries + 1} attempts`);
  }

  /**
   * Fetch only the actual_status field for a known instance.
   *
   * Returns null when the instance is gone (404) or the network call fails,
   * so callers can treat null as "dead/gone" without an explicit error path.
   *
   * Intentionally no retries — used by the reaper where a transient null
   * is safe (the instance will be checked again on the next reaper cycle).
   */
  async getInstanceStatus(instanceId: number): Promise<string | null> {
    const url = `${this.baseUrl}/instances/${instanceId}/`;
    try {
      const response = await this.request('GET', url, undefined, 'getInstanceStatus');
      const raw = response as { instances?: VastInstance | VastInstance[] };
      const instance = Array.isArray(raw.instances) ? raw.instances[0] : raw.instances;
      return (instance as { actual_status?: string } | undefined)?.actual_status ?? null;
    } catch {
      // Instance gone or network failure — treat as dead.
      return null;
    }
  }

  /**
   * Permanently destroy an instance.
   *
   * Uses DELETE (not stop). Stopped instances continue billing on Vast.ai.
   * This is the ONLY acceptable way to end a Vast instance in this project.
   */
  async destroyInstance(instanceId: number): Promise<void> {
    const url = `${this.baseUrl}/instances/${instanceId}/`;
    await this.request('DELETE', url, undefined, 'destroyInstance');

    logger.info('vast instance destroyed', { instance_id: instanceId });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async request(
    method: string,
    url: string,
    body: Record<string, unknown> | undefined,
    operation: string,
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new VastApiError(operation, 0, `network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const text = await response.text();
        // Include response body for debugging, but truncate to avoid log bloat.
        detail = text.slice(0, 200);
      } catch {
        // Ignore body read errors.
      }
      throw new VastApiError(operation, response.status, detail);
    }

    try {
      return await response.json();
    } catch {
      // DELETE responses may have no body — return empty object.
      return {};
    }
  }
}
