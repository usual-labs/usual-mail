// Fake web hosts for the Cloudflare picture tests, answered in this Node process through Miniflare's outbound service
// (harness.ts, `web`): picture and site hosts by name, and Cloudflare's DNS-over-HTTPS resolver, whose answers each test
// sets. Every request is recorded. Nothing reaches the real network: a host no test named is refused by the harness.

import { Response as MiniflareResponse, type Request as MiniflareRequest } from "miniflare";

export const DOH_HOST = "cloudflare-dns.com";

export interface SeenRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
}

export type HostHandler = (request: MiniflareRequest, url: URL) => MiniflareResponse | Promise<MiniflareResponse>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeWeb {
  /** Every request to a picture or site host, in order. */
  readonly requests: SeenRequest[] = [];
  /** Every question the resolver was asked. */
  readonly questions: Array<{ name: string; type: string }> = [];
  readonly #names = new Map<string, string[]>();
  readonly #hosts = new Map<string, HostHandler>();
  /** Set to make the resolver fail (an answer) or hang (null) for every question. */
  resolver: ((name: string, type: string) => MiniflareResponse | null) | null = null;

  /** What the resolver answers for a name: these addresses (IPv4 and IPv6 apart by their form). */
  name(host: string, ...addresses: string[]): this {
    this.#names.set(host, addresses);
    return this;
  }

  /** A host the fake serves, by name, at public addresses unless `name()` gives others. */
  host(host: string, handler: HostHandler, addresses = ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]): this {
    this.#hosts.set(host, handler);
    if (!this.#names.has(host)) this.#names.set(host, addresses);
    return this;
  }

  /** Requests a host got. */
  seen(host: string): SeenRequest[] {
    return this.requests.filter((request) => request.host === host);
  }

  /** The harness's hook: an answer for the hosts the fake knows, undefined for any other. */
  readonly handle = async (request: MiniflareRequest): Promise<MiniflareResponse | undefined> => {
    const url = new URL(request.url);
    if (url.hostname === DOH_HOST) return this.#resolve(url);
    const handler = this.#hosts.get(url.hostname);
    if (!handler) return undefined;
    this.requests.push({ host: url.hostname, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers) });
    return handler(request, url);
  };

  async #resolve(url: URL): Promise<MiniflareResponse> {
    const name = url.searchParams.get("name") ?? "";
    const type = url.searchParams.get("type") ?? "";
    this.questions.push({ name, type });
    if (this.resolver) {
      const answer = this.resolver(name, type);
      if (answer) return answer;
      await wait(5_000);
      return new MiniflareResponse("late", { status: 504 });
    }
    const addresses = this.#names.get(name);
    if (!addresses) return MiniflareResponse.json({ Status: 3, Answer: [] });
    const code = type === "AAAA" ? 28 : 1;
    const answers = addresses.filter((address) => address.includes(":") === (code === 28)).map((data) => ({ name, type: code, TTL: 60, data }));
    return MiniflareResponse.json({ Status: 0, Answer: answers }, { headers: { "content-type": "application/dns-json" } });
  }
}

/** Serves these bytes with this type. */
export function serve(body: Uint8Array | string, type = "image/png", headers: Record<string, string> = {}): HostHandler {
  return () => new MiniflareResponse(typeof body === "string" ? body : body.slice(), { status: 200, headers: { "content-type": type, ...headers } });
}

/** Redirects to `location`. */
export function redirect(location: string, status = 302): HostHandler {
  return () => new MiniflareResponse(null, { status, headers: { location } });
}

/** Answers only after `ms`. */
export function slow(ms: number, then: HostHandler): HostHandler {
  return async (request, url) => {
    await wait(ms);
    return then(request, url);
  };
}

/** Answers at once, then sends a byte every 100 ms for `ms`. */
export function trickle(ms: number): HostHandler {
  return () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await wait(100);
        if ((sent += 100) >= ms) controller.close();
        else controller.enqueue(new Uint8Array([0]));
      },
    });
    return new MiniflareResponse(body, { status: 200, headers: { "content-type": "image/png" } });
  };
}

/** What the test entry's web hook answers (worker/hooks.ts). */
export interface WebAnswer {
  ok: boolean;
  /** A refusal's words and kind ("refused" for good, "failed" may pass), or "error". */
  message?: string;
  kind?: "refused" | "failed" | "error";
  size?: number;
  sizes?: number[];
  /** Whether a picture came as a stream of its kept parts, and each chunk's size. */
  streamed?: boolean;
  chunks?: number[] | null;
  url?: string;
  text?: string;
  mimeType?: string;
  found?: boolean;
  fit?: "fill" | "inset";
  reason?: string;
}

/** Runs one of the test entry's web operations in the object (worker/hooks.ts, `POST /__test/web`). */
export async function webOp(server: { call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> }, body: Record<string, unknown>): Promise<WebAnswer> {
  const answer = await server.call("POST", "/__test/web", body);
  if (answer.status !== 200) throw new Error(`The web hook answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body as WebAnswer;
}
