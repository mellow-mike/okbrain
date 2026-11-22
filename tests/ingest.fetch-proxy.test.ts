import { describe, expect, test } from "bun:test";
import { guardedFetchProxy, GuardedFetchProxyError } from "../src/core/ingest/fetch-proxy.ts";

const origin = new URL("https://updates.example.org/guide");
const proxy = "http://proxy.example.org:3128/";

describe("guarded fetch proxy selection", () => {
  test("uses the scheme-specific setting before the shared setting and prefers lowercase", () => {
    const env = { https_proxy: "https://secure-proxy.example.org/", HTTPS_PROXY: proxy,
      http_proxy: "http://plain-proxy.example.org/", HTTP_PROXY: proxy, ALL_PROXY: "https://shared.example.org/" };
    expect(guardedFetchProxy(origin, env)).toBe(env.https_proxy);
    expect(guardedFetchProxy(new URL("http://203.0.113.10/guide"), env)).toBe(env.http_proxy);
    expect(guardedFetchProxy(origin, { ...env, https_proxy: "" })).toBe(env.HTTPS_PROXY);
    expect(guardedFetchProxy(origin, { all_proxy: "proxy.example.org:3128", ALL_PROXY: env.ALL_PROXY })).toBe(proxy);
    for (const empty of ['""', "''"]) {
      expect(guardedFetchProxy(origin, { ...env, https_proxy: empty })).toBe(env.ALL_PROXY);
      expect(guardedFetchProxy(origin, { all_proxy: empty, ALL_PROXY: env.ALL_PROXY })).toBe(false);
    }
    expect(guardedFetchProxy(origin, { HTTP_PROXY: proxy })).toBe(false);
    expect(guardedFetchProxy(origin, {})).toBe(false);
  });

  test("matches the original DNS name on label boundaries, with an optional effective port", () => {
    const select = (url: string, no_proxy: string) => guardedFetchProxy(new URL(url), { HTTPS_PROXY: proxy, no_proxy });
    for (const rule of ["EXAMPLE.org", ".example.org", "*.example.org", "UPDATES.EXAMPLE.ORG.", "*"]) {
      expect(select(origin.href, rule)).toBe(false);
    }
    expect(select("https://example.org/", "*.example.org")).toBe(false);
    expect(select("https://example.org./", "*.example.org")).toBe(false);
    expect(select("https://updates.example.org:8443/", "other.example, EXAMPLE.ORG:8443")).toBe(false);
    expect(select(origin.href, "example.org:443")).toBe(false);
    expect(select(origin.href, "example.org:80")).toBe(proxy);
    expect(select("https://updates.example.org:8443/", "example.org:443")).toBe(proxy);
    expect(select("https://unrelated-example.org/", "example.org")).toBe(proxy);
    expect(select("https://example.org.unrelated.net/", "example.org")).toBe(proxy);
    expect(select("https://k.example.org/", "\u212a.example.org")).toBe(proxy);
    expect(select(origin.href, "https://updates.example.org, [updates.example.org], example.org:invalid")).toBe(proxy);
    expect(guardedFetchProxy(origin, { HTTPS_PROXY: proxy, no_proxy: "other.example", NO_PROXY: "*" })).toBe(proxy);
    for (const empty of ["", '""', "''"]) {
      expect(guardedFetchProxy(origin, { HTTPS_PROXY: proxy, no_proxy: empty, NO_PROXY: "*" })).toBe(false);
    }
  });

  test("honors IPv4 and IPv6 literals, optional bracketed ports and CIDRs on literal origins only", () => {
    const select = (url: string, NO_PROXY: string) => guardedFetchProxy(new URL(url), { HTTPS_PROXY: proxy, NO_PROXY });
    expect(select("https://203.0.113.77/", "203.0.113.0/24")).toBe(false);
    expect(select("https://203.0.113.77/", "203.0.113.77:443")).toBe(false);
    expect(select("https://203.0.113.77/", "113.77, ::/0, 203.0.113.0/33")).toBe(proxy);
    expect(select("https://203.0.114.77/", "203.0.113.0/24")).toBe(proxy);
    expect(select("https://[2001:db8::77]/", "2001:DB8:0:0:0:0:0:77")).toBe(false);
    expect(select("https://[2001:db8::77]/", "2001:db8::/32")).toBe(false);
    expect(select("https://[2001:db8::77]:8443/", "[2001:DB8::77]:8443")).toBe(false);
    expect(select("https://[2001:db8::77]:8443/", "[2001:db8::77]:443")).toBe(proxy);
    expect(select("https://[2001:db8::77]/", "[2001:db8::77]unexpected")).toBe(proxy);
    expect(select("https://[::ffff:203.0.113.77]/", "203.0.113.0/24")).toBe(false);
    expect(select("https://203.0.113.77/", "::ffff:203.0.113.0/120")).toBe(false);
    expect(select("https://203.0.113.77/", "::ffff:203.0.113.0/95")).toBe(proxy);
    expect(select(origin.href, "0.0.0.0/0, ::/0")).toBe(proxy);
  });

  test("keeps proxy credentials on the transport route and out of configuration errors", () => {
    const authenticated = "https://fixture-user:fixture-password@proxy.example.org:8443/";
    expect(guardedFetchProxy(origin, { HTTPS_PROXY: authenticated })).toBe(authenticated);
    expect(guardedFetchProxy(origin, { HTTPS_PROXY: "[2001:db8::7]:3128" })).toBe("http://[2001:db8::7]:3128/");
    const message = "Use an HTTP or HTTPS proxy address without a path, query, or fragment.";
    for (const value of [authenticated + "extra", authenticated + "?key=fixture-token", authenticated + "#fragment",
      "socks5://fixture-user:fixture-password@proxy.example.org:1080", "http://proxy.example.org:0", "not a proxy"]) {
      const select = () => guardedFetchProxy(origin, { HTTPS_PROXY: value, ALL_PROXY: proxy });
      expect(select).toThrow(GuardedFetchProxyError);
      expect(select).toThrow(new Error(message));
    }
    expect(() => guardedFetchProxy(origin, { ALL_PROXY: "socks5://proxy.example.org:1080" })).toThrow(GuardedFetchProxyError);
    expect(guardedFetchProxy(origin, { HTTPS_PROXY: authenticated + "extra", NO_PROXY: "example.org" })).toBe(false);
  });

  test("refuses plaintext named origins through an ordinary forwarding proxy", () => {
    const plaintext = new URL("http://updates.example.org/guide");
    expect(() => guardedFetchProxy(plaintext, { HTTP_PROXY: proxy })).toThrow(
      "The configured proxy cannot preserve the hostname of this HTTP source. Use the source’s HTTPS URL.");
    expect(() => guardedFetchProxy(plaintext, { ALL_PROXY: proxy })).toThrow(GuardedFetchProxyError);
    expect(guardedFetchProxy(plaintext, { HTTP_PROXY: proxy, NO_PROXY: "example.org:80" })).toBe(false);
    expect(guardedFetchProxy(plaintext, { HTTPS_PROXY: proxy })).toBe(false);
    expect(guardedFetchProxy(new URL("http://203.0.113.4/guide"), { HTTP_PROXY: proxy })).toBe(proxy);
  });
});
