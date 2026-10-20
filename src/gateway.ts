/**
 * A small Radix Gateway client: one request in flight, an ordered list of endpoints, and a
 * network check before the first call.
 *
 * A keeper's reads are only meaningful on the network its transactions will be submitted to.
 * An endpoint that answers on another network is treated as unusable, not as an error the
 * caller has to discover later, and every fallback is asked the same question at start.
 */

import { XRD_RESOURCES, type NetworkName } from "./config.ts";

export class GatewayError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

export interface LedgerState {
  network: string;
  state_version: number;
  epoch: number;
}

export interface GatewayStatus {
  ledger_state: LedgerState;
  release_info?: unknown;
}

export interface GatewayOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Delays between retries of a 429 or 5xx answer. An empty list disables retries. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000];

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLedgerState(value: unknown): LedgerState | null {
  if (!isJsonObject(value) || !isJsonObject(value.ledger_state)) return null;
  const raw = value.ledger_state;
  if (
    typeof raw.network !== "string" ||
    typeof raw.state_version !== "number" ||
    typeof raw.epoch !== "number"
  ) {
    return null;
  }
  return {
    network: raw.network,
    state_version: raw.state_version,
    epoch: raw.epoch,
  };
}

export class Gateway {
  private readonly urls: string[];
  private readonly network: NetworkName;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  private activeIndex = 0;
  private started: GatewayStatus | null = null;
  private startPromise: Promise<GatewayStatus> | null = null;
  private readonly networkByUrl = new Map<string, string | null>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(urls: string[], network: NetworkName, options: GatewayOptions = {}) {
    if (urls.length === 0) throw new GatewayError("no gateway URL is configured");
    this.urls = urls.map((url) => url.replace(/\/+$/, ""));
    this.network = network;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? sleepDefault;
  }

  /** Ask every endpoint which network it serves; the first correct answer becomes active. */
  async status(): Promise<GatewayStatus> {
    if (this.started !== null) return this.started;
    this.startPromise ??= this.start();
    return this.startPromise;
  }

  private async start(): Promise<GatewayStatus> {
    const failures: string[] = [];
    let firstMatch: { index: number; status: GatewayStatus } | null = null;

    // Ask every configured endpoint, not just the ones needed so far: a fallback that
    // serves another network is excluded before any read can reach it.
    for (let index = 0; index < this.urls.length; index += 1) {
      const url = this.urls[index] as string;
      try {
        const answer = await this.requestOnce(url, "/status/gateway-status", {});
        const ledger = readLedgerState(answer);
        if (ledger === null) {
          failures.push(`${url} did not return a ledger state`);
          continue;
        }
        this.networkByUrl.set(url, ledger.network);
        if (ledger.network !== this.network) {
          failures.push(`${url} serves ${ledger.network}`);
          continue;
        }
        if (firstMatch === null) {
          firstMatch = {
            index,
            status: {
              ledger_state: ledger,
              ...(isJsonObject(answer) && "release_info" in answer
                ? { release_info: answer.release_info }
                : {}),
            },
          };
        }
      } catch (error) {
        this.networkByUrl.set(url, null);
        failures.push(`${url}: ${(error as Error).message}`);
      }
    }

    if (firstMatch === null) {
      throw new GatewayError(
        `no configured gateway serves ${this.network} (${failures.join("; ")})`,
      );
    }
    this.activeIndex = firstMatch.index;
    this.started = firstMatch.status;
    return this.started;
  }

  /**
   * POST a JSON body. `expectedStateVersion` pins a read to the exact ledger state it was
   * planned against; an answer from any other state version is refused rather than used.
   */
  async post<T = unknown>(
    path: string,
    body: unknown,
    expectedStateVersion?: number,
  ): Promise<T> {
    await this.status();
    const run = async (): Promise<T> =>
      this.postWithFallback<T>(path, body, expectedStateVersion);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async postWithFallback<T>(
    path: string,
    body: unknown,
    expectedStateVersion: number | undefined,
  ): Promise<T> {
    let lastError: unknown;
    for (let offset = 0; offset < this.urls.length; offset += 1) {
      const index = (this.activeIndex + offset) % this.urls.length;
      const url = this.urls[index] as string;
      const knownNetwork = this.networkByUrl.get(url);
      if (
        knownNetwork !== undefined &&
        knownNetwork !== null &&
        knownNetwork !== this.network
      ) {
        continue;
      }

      try {
        const answer = await this.requestOnce(url, path, body);
        if (expectedStateVersion !== undefined) {
          assertStateVersion(answer, expectedStateVersion);
        }
        this.activeIndex = index;
        return answer as T;
      } catch (error) {
        lastError = error;
        if (
          error instanceof GatewayError &&
          error.status !== null &&
          error.status < 500 &&
          error.status !== 429
        ) {
          throw error;
        }
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new GatewayError(`no gateway answered ${path}`);
  }

  private async requestOnce(
    baseUrl: string,
    path: string,
    body: unknown,
  ): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    let lastError: GatewayError | null = null;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": "oter-keeper/0.1.0",
          },
          body: JSON.stringify(body),
          ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
        });
        const text = await response.text();

        if (response.status === 429 || response.status >= 500) {
          lastError = new GatewayError(
            `HTTP ${response.status} from ${path}: ${truncate(text)}`,
            response.status,
          );
          if (attempt < this.retryDelaysMs.length) {
            await this.sleep(this.retryDelaysMs[attempt] as number);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          throw new GatewayError(
            `HTTP ${response.status} from ${path}: ${truncate(text)}`,
            response.status,
          );
        }

        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new GatewayError(`non-JSON answer from ${path}`, response.status);
        }
      } catch (error) {
        if (error instanceof GatewayError) {
          if (
            error.status === 429 ||
            (error.status !== null && error.status >= 500) ||
            error.status === null
          ) {
            lastError = error;
            if (attempt < this.retryDelaysMs.length) {
              await this.sleep(this.retryDelaysMs[attempt] as number);
              continue;
            }
          }
          throw error;
        }
        lastError = new GatewayError(
          `request to ${path} failed: ${(error as Error).message}`,
        );
        if (attempt < this.retryDelaysMs.length) {
          await this.sleep(this.retryDelaysMs[attempt] as number);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new GatewayError(`request to ${path} failed`);
  }

  /** The account's XRD balance as the Gateway reports it, or "0" when it holds none. */
  async accountXrdBalance(account: string): Promise<string> {
    const answer = await this.post<{
      items?: Array<{
        fungible_resources?: {
          items?: Array<{ resource_address?: string; amount?: string }>;
        };
      }>;
    }>("/state/entity/details", {
      addresses: [account],
      aggregation_level: "Global",
    });
    const item = answer.items?.[0];
    if (item === undefined) {
      throw new GatewayError(`the gateway does not know account ${account}`);
    }
    const xrd = item.fungible_resources?.items?.find(
      (resource) => resource.resource_address === XRD_RESOURCES[this.network],
    );
    return xrd?.amount ?? "0";
  }
}

function assertStateVersion(answer: unknown, expected: number): void {
  const ledger = readLedgerState(answer);
  if (ledger === null) {
    throw new GatewayError(
      `the answer carries no ledger state; cannot confirm state version ${expected}`,
    );
  }
  if (ledger.state_version !== expected) {
    throw new GatewayError(
      `gateway answered at state version ${ledger.state_version}, but ${expected} was requested`,
    );
  }
}
