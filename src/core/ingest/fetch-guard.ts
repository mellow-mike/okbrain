// The one guarded fetcher (F-A.1). Extracted ahead of Stage 4.2 on purpose:
// clip uses it today, the enrichment crawler reuses it later — one guard, two
// callers. Guards: http/https only; private/link-local/loopback targets
// rejected, re-checked on every redirect hop; response size cap; timeout.
// Residual risk (documented): DNS rebinding between our lookup and fetch's
// own resolution — accepted for v1, revisit with the Stage-4 crawler.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class FetchGuardError extends Error {}

export interface GuardedFetchOptions {
  /** Response size cap in bytes (default 5 MB). */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Permit loopback/private targets — tests and (future) intranet config only. */
  allowPrivate?: boolean;
}

export interface FetchedPage {
  /** URL after redirects (what the body actually came from). */
  url: string;
  contentType: string;
  body: string;
}

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

async function assertAllowed(url: URL, allowPrivate: boolean): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new FetchGuardError(`only http/https URLs can be fetched: ${url.protocol}//`);
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    addrs = isIP(host) !== 0 ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new FetchGuardError(`cannot resolve host: ${url.hostname}`);
  }
  for (const { address } of addrs)
    if (isPrivateIp(address))
      throw new FetchGuardError(
        `refusing to fetch a private/loopback address: ${url.hostname} → ${address}`,
      );
}

/** Fetch a page within the guardrails; returns decoded UTF-8 text. */
export async function guardedFetch(
  rawUrl: string,
  opts: GuardedFetchOptions = {},
): Promise<FetchedPage> {
  const { maxBytes = 5_000_000, timeoutMs = 15_000, maxRedirects = 5 } = opts;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchGuardError(`not a valid URL: ${rawUrl}`);
  }

  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    await assertAllowed(url, opts.allowPrivate === true);
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "okb-clip/0.1", accept: "text/html,*/*" },
      });
    } catch (e) {
      throw new FetchGuardError(
        `fetch failed for ${url.href}: ${(e as Error).message} (offline? okb clip has no offline queue)`,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc === null) throw new FetchGuardError(`redirect without Location from ${url.href}`);
      if (hop >= maxRedirects)
        throw new FetchGuardError(`too many redirects (> ${maxRedirects}) from ${rawUrl}`);
      url = new URL(loc, url); // next hop re-runs the host guard
      continue;
    }
    break;
  }
  if (!res.ok)
    throw new FetchGuardError(`HTTP ${res.status} from ${url.href}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes)
    throw new FetchGuardError(`response too large (${declared} bytes > ${maxBytes} cap)`);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FetchGuardError(`response too large (> ${maxBytes} byte cap)`);
      }
      chunks.push(value);
    }
  const body = new TextDecoder().decode(Buffer.concat(chunks));
  return { url: url.href, contentType: res.headers.get("content-type") ?? "", body };
}
