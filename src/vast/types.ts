/**
 * Vast.ai REST API type definitions.
 *
 * Only fields used in this project are declared.
 * Full Vast.ai API docs: https://vast.ai/docs/api
 */

export interface VastOffer {
  id: number;
  gpu_name: string;
  num_gpus: number;
  /** GPU VRAM in MB (e.g. 32768 = 32 GB) */
  gpu_ram: number;
  /** System RAM in MB (e.g. 64280 ≈ 64 GB) */
  cpu_ram: number;
  /** Available disk space in GB */
  disk_space: number;
  /** Total cost in USD per hour */
  dph_total: number;
  rentable: boolean;
  /** Reliability score 0–1 */
  reliability2: number;
  /** Upload bandwidth in Mbps */
  inet_up: number;
  /** Download bandwidth in Mbps */
  inet_down: number;
  cuda_max_good?: number;
  machine_id?: number;
  /**
   * Vast.ai host (owner) id. One host owns many machines and rotates machine ids,
   * so this — not machine_id — is the stable identity of a bad provider.
   */
  host_id?: number;
  /**
   * Public egress IP. Multi-tenant hosts put every container behind one IP, which
   * is why anonymous Docker Hub pulls (rate-limited per IP) wedge on busy hosts.
   */
  public_ipaddr?: string;
  datacenter?: string;
  /** Datacenter location string, ends with ", XX" ISO country code (e.g. "US, TX, Dallas, US") */
  geolocation?: string;
  /** Vast.ai host verification status: 'verified' | 'unverified' | 'deverified'. */
  verification?: string;
}

export interface VastInstance {
  id: number;
  actual_status: 'created' | 'loading' | 'running' | 'stopped' | 'exited' | 'error';
  cur_state: string;
  gpu_name: string;
  num_gpus: number;
  label?: string;
  /** Extra environment variables set at launch time */
  extra_env?: Record<string, string>;
  /** Unix epoch seconds */
  start_date?: number;
  end_date?: number;
  ssh_host?: string;
  ssh_port?: number;
  dph_total?: number;
  image_uuid?: string;
}

export interface VastSearchQuery {
  /** GPU model name filter, e.g. "RTX 5090" (Vast.ai uses spaces, not underscores) */
  gpu_name?: string;
  /** Minimum GPU VRAM in GB (converted to MB internally for Vast.ai API) */
  min_gpu_ram?: number;
  /** Minimum system RAM in GB (converted to MB internally for Vast.ai API) */
  min_cpu_ram?: number;
  /** Minimum available disk space in GB */
  min_disk_space?: number;
  /** Minimum reliability score 0–1. Maps to Vast.ai field: reliability2 */
  min_reliability?: number;
  /** Minimum download bandwidth in Mbps (e.g. 500 ≈ 60 MB/s). Filters slow instances. */
  min_inet_down?: number;
  /**
   * Require Vast.ai-"verified" hosts only. Verified hosts pass Vast.ai's automated
   * GPU-container verification; unverified/deverified hosts are the main source of
   * "failed to inject CDI devices" / OCI-runtime errors (broken nvidia-container-toolkit).
   * Maps to server-side filter `verified: {eq: true}`. Confirmed no price premium.
   */
  verified?: boolean;
  /**
   * Minimum `cuda_max_good` — the highest CUDA version the host driver supports.
   * Set to 12.8 to guarantee the driver can run cu128 / Blackwell (sm_120) kernels.
   * Maps to server-side filter `cuda_max_good: {gte: N}`.
   */
  min_cuda_max_good?: number;
  /** Exact number of GPUs required (e.g. 1, 2, 4 for multi-GPU streams) */
  num_gpus?: number;
  /**
   * Country codes to exclude (ISO 2-letter, e.g. ['CN']).
   * Vast.ai `geolocation` ends with ", XX" — filtered client-side after API response.
   * Essential: CN datacenters report high local inet_down but have slow Cloudflare R2
   * throughput (~20 MB/s vs 150+ MB/s from US/EU), causing 2–3× longer cold starts.
   */
  excluded_countries?: string[];
  /**
   * Vast.ai machine IDs to exclude from offer selection — filtered client-side.
   * Use to permanently block known-broken hosts (e.g. CDI/GPU injection failures).
   * Populated from the VAST_EXCLUDED_MACHINES env var.
   */
  excluded_machine_ids?: number[];
  /**
   * Vast.ai HOST ids to exclude — filtered client-side. Combines two sources:
   * the permanent VAST_EXCLUDED_HOSTS env list, and hosts that recently stalled a
   * stream (from the host_failures table). This is the filter that stops the
   * "cheapest offer is always the same broken host" retry loop.
   */
  excluded_host_ids?: number[];
  /** Sort expression, e.g. "dph_total asc" */
  order?: string;
  /** Maximum number of results (default: 20) */
  limit?: number;
}

export interface VastStartConfig {
  /** Docker image to run */
  image: string;
  /** Shell command executed at startup */
  onstart?: string;
  /** Environment variables injected into the instance */
  env?: Record<string, string>;
  /** Human-readable label for identification in Vast dashboard */
  label?: string;
  /** Disk space to allocate in GB */
  disk?: number;
  /**
   * Docker registry credentials, in `docker login` argument form:
   *   "-u USERNAME -p TOKEN ghcr.io"
   * Maps to the Vast.ai `image_login` body field. Only needed for private images —
   * public ghcr.io pulls are unauthenticated and, unlike Docker Hub, unmetered.
   * Never logged.
   */
  image_login?: string;
}

export class VastApiError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Vast.ai API error on ${operation}: ${detail} (HTTP ${status})`);
    this.name = 'VastApiError';
  }
}
