/**
 * An in-process Gateway. Tests register an answer for a URL or path; an unregistered
 * request fails loudly, so a test that drifts from the real call sequence says so instead
 * of passing on a plausible default.
 */

import { Gateway, type GatewayOptions } from "../src/gateway.ts";

export interface RecordedRequest {
  url: string;
  path: string;
  body: unknown;
  method: string;
}

export interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
}

export type ReplySource = Reply | ((request: RecordedRequest) => Reply | Promise<Reply>);

export class FakeHttp {
  readonly calls: RecordedRequest[] = [];
  private readonly replies = new Map<string, ReplySource[]>();
  private inFlight = 0;
  maxInFlight = 0;

  /** Register an answer for an exact URL, or for a path on any host. */
  on(key: string, reply: ReplySource): this {
    const queue = this.replies.get(key) ?? [];
    queue.push(reply);
    this.replies.set(key, queue);
    return this;
  }

  count(path: string): number {
    return this.calls.filter((call) => call.path === path).length;
  }

  bodies(path: string): unknown[] {
    return this.calls.filter((call) => call.path === path).map((call) => call.body);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const record: RecordedRequest = {
      url,
      path,
      body,
      method: init?.method ?? "GET",
    };
    this.calls.push(record);

    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const source = this.take(url, path);
      const reply = typeof source === "function" ? await source(record) : source;
      const text = reply.text ?? JSON.stringify(reply.body ?? {});
      return new Response(text, { status: reply.status ?? 200 });
    } finally {
      this.inFlight -= 1;
    }
  };

  private take(url: string, path: string): ReplySource {
    for (const key of [url, path]) {
      const queue = this.replies.get(key);
      const reply = queue?.shift();
      if (reply !== undefined) return reply;
    }
    throw new Error(`unexpected request ${url}`);
  }
}

export function statusBody(
  network = "stokenet",
  stateVersion = 100,
  epoch = 10,
): {
  ledger_state: {
    network: string;
    state_version: number;
    epoch: number;
    proposer_round_timestamp: string;
    round: number;
  };
  release_info: { release_version: string };
} {
  return {
    ledger_state: {
      network,
      state_version: stateVersion,
      epoch,
      proposer_round_timestamp: "2026-10-20T00:00:00.000Z",
      round: 1,
    },
    release_info: { release_version: "test" },
  };
}

export function makeGateway(http: FakeHttp, options: GatewayOptions = {}): Gateway {
  return new Gateway(["https://gateway.test"], "stokenet", {
    fetchImpl: http.fetch,
    retryDelaysMs: [],
    timeoutMs: 1_000,
    ...options,
  });
}
