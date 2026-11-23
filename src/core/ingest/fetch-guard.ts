// Shared transport for Clip, RSS, and enrichment. Validate each redirect and
// connect only to a vetted numeric address, using the origin for HTTP and TLS.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { guardedFetchProxy, GuardedFetchProxyError } from "./fetch-proxy.ts";

export class FetchGuardError extends Error {}

export interface GuardedFetchOptions {
  /** Response size cap in bytes (default 5 MB). */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Permit loopback/private targets — tests and (future) intranet config only. */
  allowPrivate?: boolean;
  /** Throw to refuse a URL before DNS or connection, including after a redirect. */
  authorizeUrl?: (url: URL) => void;
}

export interface FetchedPage {
  /** URL after redirects (what the body actually came from). */
  url: string;
  contentType: string;
  body: string;
}

interface GuardedFetchDependencies {
  resolve?: (hostname: string) => Promise<readonly { address: string }[]>;
  fetch?: (input: URL, init: BunFetchRequestInit) => Promise<Response>;
  env?: Record<string, string | undefined>;
}

const supportsPinnedFetch = Bun.semver.satisfies(Bun.version, ">=1.4.3");

const v4Private = (ip: string): boolean => {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT shared space
    a >= 224 // multicast (224/4) and reserved/broadcast (240/4)
  );
};

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null when it isn't one.
 * Textual matching on the un-expanded form cannot classify IPv6: `::1`,
 * `0:0:0:0:0:0:0:1` and `::ffff:7f00:1` all reach loopback but look nothing
 * alike, so every check below runs on the expanded groups instead.
 */
function hextets(raw: string): number[] | null {
  let s = raw;
  // A trailing dotted quad (`::ffff:127.0.0.1`) is the low two groups.
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (dotted) {
    const b = dotted[2]!.split(".").map(Number);
    if (b.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${dotted[1]!}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 0 ? null : [...head, ...(Array(fill).fill(0) as number[]), ...tail];
}

const v6Private = (ip: string): boolean => {
  const h = hextets(ip.toLowerCase());
  if (h === null) return true; // unclassifiable → refuse, never assume public
  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) addresses
  // route to the v4 destination in their low 32 bits — classify them as that
  // address. `::` and `::1` fall out of this as 0.0.0.0 / 0.0.0.1.
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0))
    return v4Private(`${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`);
  return (
    (h[0]! & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (h[0]! & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (h[0]! & 0xff00) === 0xff00 // ff00::/8 multicast
  );
};

export const isPrivateIp = (ip: string): boolean =>
  isIP(ip) === 4 ? v4Private(ip) : v6Private(ip.replace(/^\[|\]$/g, ""));

function authorize(url: URL, { authorizeUrl }: GuardedFetchOptions): void {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new FetchGuardError(`only http/https URLs can be fetched: ${url.protocol}//`);
  if (url.username || url.password) throw new FetchGuardError("Remove credentials from the source URL before fetching it.");
  authorizeUrl?.(new URL(url));
}

function beforeTimeout<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

async function vettedAddresses(
  host: string,
  allowPrivate: boolean,
  signal: AbortSignal,
  resolve: NonNullable<GuardedFetchDependencies["resolve"]>,
): Promise<string[]> {
  let addresses: readonly { address: string }[];
  try {
    signal.throwIfAborted();
    addresses = isIP(host) ? [{ address: host }] : await beforeTimeout(resolve(host), signal);
  } catch {
    signal.throwIfAborted();
    throw new FetchGuardError(`cannot resolve host: ${host}`);
  }
  if (!addresses.length || addresses.some(({ address }) => !isIP(address) || address.includes("%")))
    throw new FetchGuardError(`cannot resolve host to a valid address: ${host}`);
  if (!allowPrivate && addresses.some(({ address }) => isPrivateIp(address)))
    throw new FetchGuardError(`refusing to fetch a private/loopback address: ${host}`);
  return [...new Set(addresses.map(({ address }) => address))];
}

async function fetchPinned(
  url: URL,
  host: string,
  addresses: string[],
  proxy: string | false,
  signal: AbortSignal,
  request: NonNullable<GuardedFetchDependencies["fetch"]>,
): Promise<Response> {
  const headers = { host: url.host, "user-agent": "okb-clip/0.1", accept: "text/html,*/*" };
  // Avoid sharing a connection across origins even when their numeric addresses match.
  const tls = { rejectUnauthorized: true, ...(url.protocol === "https:" && !isIP(host) ? { serverName: host } : {}) };
  // NO_PROXY has already been matched against the origin, not the dial address.
  const proxyOption = proxy === false ? false : { url: proxy, respectNoProxy: false };
  const port = url.port ? `:${url.port}` : "";
  for (const address of addresses) {
    const numericHost = isIP(address) === 6 ? `[${address}]` : address;
    const target = new URL(`${url.protocol}//${numericHost}${port}${url.pathname}${url.search}`);
    signal.throwIfAborted();
    try {
      return await beforeTimeout(request(target, { headers, tls, proxy: proxyOption, redirect: "manual", keepalive: false, signal }), signal);
    } catch {
      signal.throwIfAborted();
      // Fall back only to an address in the same checked answer set.
    }
  }
  throw new FetchGuardError(`fetch failed for ${url.host}${proxy ? " through the configured proxy" : ""}. Check network access and TLS trust.`);
}

function cancel(body: ReadableStream | null) {
  void body?.cancel().catch(() => {});
}

async function readBody(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    cancel(res.body);
    throw new FetchGuardError(`response too large (${declared} bytes > ${maxBytes} cap)`);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await beforeTimeout(reader.read(), signal);
      if (done) return new TextDecoder().decode(Buffer.concat(chunks));
      total += value.length;
      if (total > maxBytes) throw new FetchGuardError(`response too large (> ${maxBytes} byte cap)`);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Fetch a page within one DNS, redirect, and response deadline. */
export async function guardedFetch(
  rawUrl: string,
  opts: GuardedFetchOptions = {},
  deps: GuardedFetchDependencies = {},
): Promise<FetchedPage> {
  if (!supportsPinnedFetch) throw new FetchGuardError("Guarded browsing requires Bun 1.4.3 or newer. Update Bun or open the current okbrain app.");
  const { maxBytes = 5_000_000, timeoutMs = 15_000, maxRedirects = 5 } = opts;
  const { resolve = (host) => lookup(host, { all: true }), fetch: request = fetch, env = process.env } = deps;
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new FetchGuardError("not a valid URL"); }
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    for (let hop = 0; ; hop++) {
      authorize(url, opts);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const proxy = guardedFetchProxy(url, env);
      const addresses = await vettedAddresses(host, opts.allowPrivate === true, signal, resolve);
      const res = await fetchPinned(url, host, addresses, proxy, signal, request);
      if (res.status >= 300 && res.status < 400) {
        cancel(res.body);
        const location = res.headers.get("location");
        if (location === null) throw new FetchGuardError(`redirect without Location from ${url.host}`);
        if (hop >= maxRedirects) throw new FetchGuardError(`too many redirects (> ${maxRedirects})`);
        try { url = new URL(location, url); }
        catch { throw new FetchGuardError(`invalid redirect Location from ${url.host}`); }
        continue;
      }
      if (!res.ok) {
        cancel(res.body);
        throw new FetchGuardError(`HTTP ${res.status} from ${url.host}`);
      }
      const body = await readBody(res, maxBytes, signal);
      return { url: url.href, contentType: res.headers.get("content-type") ?? "", body };
    }
  } catch (error) {
    if (signal.aborted) throw new FetchGuardError(`fetch failed for ${url.host}: timed out after ${timeoutMs} ms`);
    if (error instanceof GuardedFetchProxyError) throw new FetchGuardError(error.message);
    throw error;
  }
}
