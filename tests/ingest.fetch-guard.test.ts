import { expect, test } from "bun:test";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { FetchGuardError, guardedFetch } from "../src/core/ingest/fetch-guard.ts";

const loopback = "127.0.0.1";
const direct = { env: {} };
const encode = new TextEncoder();
// This test-only certificate identifies github.com. Fixture sockets stay on loopback.
const cert = Bun.file(fileURLToPath(new URL("./fixtures/restore-github-test-cert.pem", import.meta.url)));
const key = Bun.file(fileURLToPath(new URL("./fixtures/restore-github-test-key.pem", import.meta.url)));

function openBody(text: string, cancel: () => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encode.encode(text)); },
    cancel,
  });
}

test("guarded ingest connects to the resolved address and preserves each redirect's original host", async () => {
  const requests: { host: string | null; path: string }[] = [];
  const server = Bun.serve({ hostname: loopback, port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push({ host: request.headers.get("host"), path: url.pathname + url.search });
    if (url.pathname === "/start") return new Response(null, {
      status: 302, headers: { location: `http://assets.fixture.test:${url.port}/article?format=plain` },
    });
    return new Response("Café fixture", { headers: { "content-type": "text/plain; charset=utf-8" } });
  } });
  const entry = `http://news.fixture.test:${server.port}/start`;
  const final = `http://assets.fixture.test:${server.port}/article?format=plain`;
  const order: string[] = [];
  try {
    const page = await guardedFetch(entry, {
      allowPrivate: true,
      maxBytes: encode.encode("Café fixture").length,
      authorizeUrl(url) { order.push(`allow ${url.hostname}`); },
    }, {
      ...direct,
      resolve: async (host) => {
        order.push(`resolve ${host}`);
        return [{ address: loopback }];
      },
      fetch: (url, init) => {
        expect(url.hostname).toBe(loopback);
        expect(init.redirect).toBe("manual");
        order.push(`connect ${url.pathname}`);
        return fetch(url, init);
      },
    });
    expect(page).toEqual({ url: final, contentType: "text/plain; charset=utf-8", body: "Café fixture" });
    expect(requests).toEqual([
      { host: `news.fixture.test:${server.port}`, path: "/start" },
      { host: `assets.fixture.test:${server.port}`, path: "/article?format=plain" },
    ]);
    expect(order).toEqual([
      "allow news.fixture.test", "resolve news.fixture.test", "connect /start",
      "allow assets.fixture.test", "resolve assets.fixture.test", "connect /article",
    ]);
  } finally { await server.stop(true); }
});

const rejectedResolutions = [
  { name: "empty", addresses: [], allowPrivate: true },
  { name: "invalid", addresses: [loopback, "not-an-address"], allowPrivate: true },
  { name: "scoped IPv6", addresses: [loopback, "2001:db8::10%zone"], allowPrivate: true },
  { name: "private", addresses: [loopback], allowPrivate: false },
  { name: "mixed public and private", addresses: ["192.0.2.10", "192.168.12.5"], allowPrivate: false },
];

for (const { name, addresses, allowPrivate } of rejectedResolutions) {
  test(`guarded ingest refuses ${name} DNS results before opening a connection`, async () => {
    const lookedUp: string[] = [];
    let requests = 0;
    await expect(guardedFetch("http://news.fixture.test/", { allowPrivate }, {
      ...direct,
      resolve: async (host) => {
        lookedUp.push(host);
        return addresses.map((address) => ({ address }));
      },
      fetch: async () => {
        requests++;
        return new Response("unexpected request");
      },
    })).rejects.toThrow(FetchGuardError);
    expect(lookedUp).toEqual(["news.fixture.test"]);
    expect(requests).toBe(0);
  });
}

test("guarded ingest falls back within the checked address set after a connection failure", async () => {
  const refused = "127.0.0.2";
  const seen: string[] = [];
  let resolutions = 0;
  const server = Bun.serve({ hostname: loopback, port: 0, fetch: () => new Response("fallback fixture") });
  const original = `http://news.fixture.test:${server.port}/article`;
  try {
    const result = await guardedFetch(original, { allowPrivate: true }, {
      ...direct,
      resolve: async () => {
        resolutions++;
        return [{ address: refused }, { address: loopback }];
      },
      fetch: (url, init) => {
        seen.push(url.hostname);
        if (url.hostname === refused) {
          return Promise.reject(Object.assign(new Error("Fixture connection refused"), { code: "ECONNREFUSED" }));
        }
        expect(url.hostname).toBe(loopback);
        expect(new Headers(init.headers).get("host")).toBe(`news.fixture.test:${server.port}`);
        return fetch(url, init);
      },
    });
    expect(seen).toEqual([refused, loopback]);
    expect(resolutions).toBe(1);
    expect(result.url).toBe(original);
    expect(result.body).toBe("fallback fixture");
  } finally { await server.stop(true); }
});

test("guarded ingest validates the original TLS name and requires a trusted certificate", async () => {
  const hosts: (string | null)[] = [];
  const tlsOptions: { serverName?: string; rejectUnauthorized?: boolean }[] = [];
  const server = Bun.serve({ hostname: loopback, port: 0, tls: { cert, key }, fetch(request) {
    hosts.push(request.headers.get("host"));
    return new Response("local TLS fixture");
  } });
  const opts = { allowPrivate: true };
  async function fetchFixture(hostname: string, trusted: boolean) {
    return guardedFetch(`https://${hostname}:${server.port}/article`, opts, {
      ...direct,
      resolve: async () => [{ address: loopback }],
      fetch: (url, init) => {
        expect(url.hostname).toBe(loopback);
        tlsOptions.push({ serverName: init.tls?.serverName, rejectUnauthorized: init.tls?.rejectUnauthorized });
        return fetch(url, { ...init, tls: { ...init.tls, ...(trusted ? { ca: cert } : {}) } });
      },
    });
  }
  try {
    const page = await fetchFixture("github.com", true);
    expect(page.url).toBe(`https://github.com:${server.port}/article`);
    expect(page.body).toBe("local TLS fixture");
    await expect(fetchFixture("unrelated.fixture.test", true)).rejects.toThrow(FetchGuardError);
    await expect(fetchFixture("github.com", false)).rejects.toThrow(FetchGuardError);
    expect(hosts).toEqual([`github.com:${server.port}`]);
    expect(tlsOptions).toEqual(["github.com", "unrelated.fixture.test", "github.com"].map((serverName) => ({ serverName, rejectUnauthorized: true })));
  } finally { await server.stop(true); }
});

test("guarded ingest reaches its checked HTTPS address through the configured CONNECT fixture", async () => {
  const hosts: (string | null)[] = [];
  const lines: string[] = [];
  const routes: BunFetchRequestInit["proxy"][] = [];
  const sockets = new Set<Socket>();
  let accepting = true;
  const server = Bun.serve({ hostname: loopback, port: 0, tls: { cert, key }, fetch(request) {
    hosts.push(request.headers.get("host"));
    return new Response("via fixture proxy", { headers: { connection: "close" } });
  } });
  const port = server.port!;
  const expected = `CONNECT ${loopback}:${port} HTTP/1.1`;
  const proxy = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buffered = Buffer.alloc(0);
    client.on("data", function requestTunnel(data) {
      buffered = Buffer.concat([buffered, typeof data === "string" ? Buffer.from(data) : data]);
      if (buffered.length > 8192) return client.destroy();
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", requestTunnel);
      const line = buffered.subarray(0, buffered.indexOf("\r\n")).toString("ascii");
      lines.push(line);
      if (!accepting || line !== expected) {
        return client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
      client.pause();
      // The endpoint is fixed to the owned test fixture, independent of the received request.
      const upstream = connect(port, loopback, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const tail = buffered.subarray(end + 4);
        if (tail.length) upstream.write(tail);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, loopback, resolve);
    });
    const proxyUrl = `http://${loopback}:${(proxy.address() as AddressInfo).port}/`;
    const expectedProxy = { url: proxyUrl, respectNoProxy: false };
    const original = `https://github.com:${port}/article`;
    const deps = {
      env: { HTTPS_PROXY: proxyUrl, NO_PROXY: loopback },
      resolve: async () => [{ address: loopback }],
      fetch: (url: URL, init: BunFetchRequestInit) => {
        expect(url.host).toBe(`${loopback}:${port}`);
        routes.push(init.proxy);
        expect(init.proxy).toEqual(expectedProxy);
        return fetch(url, { ...init, tls: { ...init.tls, ca: cert } });
      },
    };
    const page = await guardedFetch(original, { allowPrivate: true }, deps);
    expect(page.url).toBe(original);
    expect(page.body).toBe("via fixture proxy");
    accepting = false;
    await expect(guardedFetch(original, { allowPrivate: true }, deps)).rejects.toThrow(FetchGuardError);
    expect(routes).toEqual([expectedProxy, expectedProxy]);
    expect(lines).toEqual([expected, expected]);
    expect(hosts).toEqual([`github.com:${port}`]);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await server.stop(true);
  }
});

test("guarded ingest never tries another address after an HTTP response", async () => {
  const seen: string[] = [];
  let cancelled = false;
  await expect(guardedFetch("http://news.fixture.test/", { allowPrivate: true }, {
    ...direct,
    resolve: async () => [{ address: loopback }, { address: "127.0.0.2" }],
    fetch: async (url) => {
      seen.push(url.hostname);
      return new Response(openBody("unavailable", () => { cancelled = true; }), { status: 503 });
    },
  })).rejects.toThrow(/HTTP 503/);
  expect(seen).toEqual([loopback]);
  expect(cancelled).toBe(true);
});

test("guarded ingest expires during DNS resolution without opening a connection", async () => {
  let connected = false;
  await expect(guardedFetch("http://news.fixture.test/", { timeoutMs: 35 }, {
    ...direct,
    resolve: () => new Promise(() => {}),
    fetch: async () => {
      connected = true;
      return new Response("unexpected connection");
    },
  })).rejects.toThrow(FetchGuardError);
  expect(connected).toBe(false);
});

test("guarded ingest does not retry a connection after the deadline", async () => {
  const seen: string[] = [];
  await expect(guardedFetch("http://news.fixture.test/", { allowPrivate: true, timeoutMs: 80 }, {
    ...direct,
    resolve: async () => [{ address: loopback }, { address: "127.0.0.2" }],
    fetch: (url, init) => {
      seen.push(url.hostname);
      if (url.hostname !== loopback) return Promise.resolve(new Response("unexpected retry"));
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  })).rejects.toThrow(FetchGuardError);
  expect(seen).toEqual([loopback]);
});

test("guarded ingest shares one deadline across redirect DNS and the final body read", async () => {
  const seen: string[] = [];
  let redirectCancelled = false;
  let bodyCancelled = false;
  await expect(guardedFetch("http://news.fixture.test/start", { allowPrivate: true, timeoutMs: 350 }, {
    ...direct,
    resolve: async (hostname) => {
      seen.push(hostname);
      await Bun.sleep(hostname === "news.fixture.test" ? 125 : 90);
      return [{ address: loopback }];
    },
    fetch: async (url) => {
      if (url.pathname === "/start") return new Response(openBody("moved", () => { redirectCancelled = true; }), {
        status: 302, headers: { location: "http://assets.fixture.test/article" },
      });
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(230);
          if (!bodyCancelled) {
            controller.enqueue(encode.encode("late within a separate body timeout"));
            controller.close();
          }
        },
        cancel() { bodyCancelled = true; },
      }));
    },
  })).rejects.toThrow(FetchGuardError);
  expect(seen).toEqual(["news.fixture.test", "assets.fixture.test"]);
  expect(redirectCancelled).toBe(true);
  expect(bodyCancelled).toBe(true);
});

for (const declared of [true, false]) {
  test(`guarded ingest cancels a body over its ${declared ? "declared" : "streamed"} byte limit`, async () => {
    let cancelled = false;
    await expect(guardedFetch("http://news.fixture.test/", { allowPrivate: true, maxBytes: 3 }, {
      ...direct,
      resolve: async () => [{ address: loopback }],
      fetch: async () => new Response(openBody("éé", () => { cancelled = true; }), {
        headers: declared ? { "content-length": "4" } : undefined,
      }),
    })).rejects.toThrow(/response too large/);
    expect(cancelled).toBe(true);
  });
}
