import { BlockList, isIP } from "node:net";

export class GuardedFetchProxyError extends Error {}

type IPAddress = { address: string; type: "ipv4" | "ipv6"; mapped: boolean };

function proxyValue(value: string | undefined): string | undefined {
  return value && value !== '""' && value !== "''" ? value : undefined;
}

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function ipAddress(host: string): IPAddress | undefined {
  const address = unbracket(host);
  const version = isIP(address);
  if (version === 4) return { address, type: "ipv4", mapped: false };
  if (version === 6 && !address.includes("%")) {
    const mapped = new URL(`http://[${address}]`).hostname.startsWith("[::ffff:");
    return { address, type: "ipv6", mapped };
  }
}

function matchAddress(host: IPAddress, pattern: string, prefix?: number): boolean {
  const rule = ipAddress(pattern);
  if (!rule || (host.type === "ipv4" || host.mapped) !== (rule.type === "ipv4" || rule.mapped)) return false;
  const maximum = rule.type === "ipv4" ? 32 : 128;
  const length = prefix ?? maximum;
  // Treat IPv4-mapped forms like IPv4. A mapped prefix must cover the mapping itself.
  if (length > maximum || (rule.mapped && length < 96)) return false;
  const block = new BlockList();
  block.addSubnet(rule.address, length, rule.type);
  return block.check(host.address, host.type);
}

function noProxyMatches(url: URL, list: string): boolean {
  const hostname = url.hostname.replace(/\.$/u, "").toLowerCase();
  const address = ipAddress(hostname);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return list.split(/[, \t\r\n]+/u).some((entry) => {
    if (entry === "*") return true;
    if (entry.includes("/")) {
      const cidr = /^([^/]+)\/([0-9]+)$/u.exec(entry);
      return Boolean(address && cidr && matchAddress(address, cidr[1]!, Number(cidr[2])));
    }
    // Bare IPv6 is a complete address. Use brackets to specify its port.
    if (isIP(entry) === 6) return Boolean(address && matchAddress(address, entry));
    const hostPort = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::([0-9]+))?$/u.exec(entry);
    if (!hostPort || (hostPort[3] !== undefined && Number(hostPort[3]) !== port)) return false;
    if (hostPort[1] !== undefined && isIP(hostPort[1]) !== 6) return false;
    const pattern = (hostPort[1] ?? hostPort[2]!).replace(/^(?:\*\.|\.)|\.$/gu, "");
    if (!pattern) return false;
    if (address) return matchAddress(address, pattern);
    // Bun compares DNS names using ASCII case folding. Treat other forms as unmatched.
    if (/\P{ASCII}/u.test(pattern)) return false;
    const domain = pattern.toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

function parseProxy(value: string): URL {
  const address = value.trim();
  try {
    if (!address || /[\s\\?#\u0000-\u001f\u007f]/u.test(address)) throw new Error();
    const full = address.includes("://") ? address : `http://${address}`;
    if (!/^https?:\/\/[^/]/iu.test(full)) throw new Error();
    const proxy = new URL(full);
    if (!proxy.hostname || proxy.port === "0" || proxy.pathname !== "/") throw new Error();
    return proxy;
  } catch {
    throw new GuardedFetchProxyError("Use an HTTP or HTTPS proxy address without a path, query, or fragment.");
  }
}

/** Select a route for the original origin, before its address is resolved and pinned. */
export function guardedFetchProxy(url: URL, env: Record<string, string | undefined>): string | false {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new GuardedFetchProxyError("Choose an HTTP or HTTPS source.");
  // Bun uses the nonempty lowercase variable first and falls back to the all-schemes setting.
  const specific = url.protocol === "http:" ? env.http_proxy || env.HTTP_PROXY : env.https_proxy || env.HTTPS_PROXY;
  const configured = proxyValue(specific) ?? proxyValue(env.all_proxy || env.ALL_PROXY);
  if (!configured) return false;
  const bypass = proxyValue(env.no_proxy) ?? proxyValue(env.NO_PROXY);
  if (bypass && noProxyMatches(url, bypass)) return false;
  const proxy = parseProxy(configured);
  // For plaintext forwarding, a proxy derives Host from the absolute request target (RFC 9112 §3.2.2).
  if (url.protocol === "http:" && !ipAddress(url.hostname)) {
    throw new GuardedFetchProxyError("The configured proxy cannot preserve the hostname of this HTTP source. Use the source’s HTTPS URL.");
  }
  return proxy.href;
}
