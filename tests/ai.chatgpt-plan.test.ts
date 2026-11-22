import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { runCli } from "../src/cli.ts";
import { createChatgptPlan } from "../src/core/ai/chatgpt-plan.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { getOp } from "../src/core/operations.ts";

const grantScope = "openid resource.invoke chatgpt.tokens.use.direct offline_access";
const input = [{ role: "user" as const, content: "Summarize my notes" }];

async function fakeProvider(path: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  let pending: URL;
  let clientId = "oaiapp_first";
  let lastHost: string | null = null;
  let nonceMismatch = false;
  let scopes = grantScope;
  let initialLifetime = 3600;
  let refreshes = 0;
  let responseMode: "completed" | "partial" | "limited" = "completed";
  let revoked = false;
  const requests: { path: string; method: string }[] = [];
  const transport = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = url instanceof Request ? new Request(url, init) : new Request(String(url), init);
    const route = new URL(request.url);
    requests.push({ path: route.pathname, method: request.method });
    expect(request.redirect).toBe("error");
    if (route.pathname === "/.well-known/jwks.json") return Response.json({ keys: [publicJwk] });
    if (route.pathname.endsWith("/oauth/token")) {
      const form = new URLSearchParams(await request.text());
      expect(form.get("resource")).toBe("https://api.openai.com/v1");
      expect(form.get("client_id")).toBe(clientId);
      if (form.get("grant_type") === "refresh_token") {
        expect(form.get("refresh_token")).toBe("first-refresh");
        refreshes++;
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("fake-code");
      expect(form.get("redirect_uri")).toBe(pending.searchParams.get("redirect_uri"));
      expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"))
        .toBe(pending.searchParams.get("code_challenge")!);
      const idToken = await new SignJWT({
        nonce: nonceMismatch ? "wrong" : pending.searchParams.get("nonce"), email: "person@example.test",
      }).setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
        .setIssuer("https://auth.openai.com").setAudience(clientId).setSubject(clientId)
        .setExpirationTime("1h").sign(privateKey);
      return Response.json({ id_token: idToken, access_token: "first-access", refresh_token: "first-refresh",
        token_type: "Bearer", expires_in: initialLifetime, scope: scopes });
    }
    if (route.pathname.endsWith("/oauth/revoke")) {
      const form = new URLSearchParams(await request.text());
      expect(form.get("token")).toBe(refreshes ? "new-refresh" : "first-refresh");
      expect(form.get("client_id")).toBe(clientId);
      revoked = true;
      return new Response();
    }
    expect(route.origin).toBe("https://api.openai.com");
    expect(request.headers.get("authorization")).toBe(`Bearer ${refreshes ? "new-access" : "first-access"}`);
    if (route.pathname === "/v1/models") return Response.json({ models: [
      { visibility: "hidden", slug: "hidden" },
      { visibility: "list", slug: "visible", display_name: "Visible" },
    ] });
    expect(route.pathname).toBe("/v1/responses");
    expect(await request.json()).toEqual({ model: "visible", input, stream: true, store: false });
    const end = responseMode === "limited"
      ? { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }
      : { type: "response.completed" };
    const events: object[] = [{ type: "response.output_text.delta", delta: "An answer" }];
    if (responseMode !== "partial") events.push(end);
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const plan = createChatgptPlan({ path, fetch: transport as typeof fetch, async authorize(url) {
    pending = new URL(url);
    const q = pending.searchParams;
    expect(pending.origin).toBe("https://auth.openai.com");
    expect(q.get("scope")).toContain("chatgpt.tokens.use.direct");
    if (lastHost) expect(q.get("ext_agent_host_id")).toBe(lastHost);
    lastHost = q.get("ext_agent_host_id");
    expect(lastHost).toMatch(/^urn:uuid:/);
    const callback = new URL(q.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code: "bad-code", state: "wrong-state", client_id: clientId }).toString();
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set("code", "fake-code");
    callback.searchParams.set("state", q.get("state")!);
    if (q.get("client_id") === clientId) callback.searchParams.delete("client_id");
    expect((await fetch(callback)).status).toBe(200);
  } });
  return {
    plan, requests, transport,
    client: (id: string) => { clientId = id; },
    authorizedClient: () => pending.searchParams.get("client_id"),
    revoked: () => revoked,
    expireSoon: () => { initialLifetime = 1; },
    refreshes: () => refreshes,
    wrongNonce: () => { nonceMismatch = true; },
    omitPermission: () => { scopes = "openid"; },
    response: (mode: typeof responseMode) => { responseMode = mode; },
  };
}

describe("ChatGPT plan", () => {
  test("connects, refreshes once, completes SSE, and revokes from a fresh process instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "okb-chatgpt-"));
    try {
      const path = join(root, "profiles", "accounts.db");
      const provider = await fakeProvider(path);
      expect((await provider.plan.status()).connected).toBe(false);
      await expect(provider.plan.complete(input)).rejects.toThrow("chatgpt connect");
      expect(provider.requests).toEqual([]);
      provider.expireSoon();
      expect(await provider.plan.connect("personal")).toEqual({
        account: "personal", accounts: ["personal"], email: "person@example.test", connected: true, sharing: true,
      });
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      const plan = createChatgptPlan({ path, fetch: provider.transport as typeof fetch });
      expect(await plan.models()).toEqual([{ slug: "visible", name: "Visible" }]);
      expect(await plan.complete(input)).toEqual({ model: "visible", text: "An answer" });
      expect(provider.refreshes()).toBe(1);
      provider.response("partial");
      await expect(plan.complete(input, "visible")).rejects.toThrow("before completion");
      provider.response("limited");
      await expect(plan.complete(input, "visible")).rejects.toThrow("limited or unavailable");
      expect(await plan.disconnect()).toEqual({ revoked: true });
      expect(provider.revoked()).toBe(true);
      expect(await plan.status()).toMatchObject({ account: "personal", connected: false, sharing: false });
      await expect(plan.models()).rejects.toThrow("chatgpt connect");
      await provider.plan.connect();
      expect(provider.authorizedClient()).toBe("oaiapp_first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps separate registrations and rejects unverified identity or missing consent", async () => {
    const root = await mkdtemp(join(tmpdir(), "okb-chatgpt-"));
    try {
      const provider = await fakeProvider(join(root, "accounts.db"));
      await provider.plan.connect();
      provider.client("oaiapp_second");
      await provider.plan.connect("work");
      expect(await provider.plan.use("default")).toMatchObject({ account: "default", accounts: ["default", "work"] });
      provider.client("oaiapp_third");
      provider.omitPermission();
      await expect(provider.plan.connect("third")).rejects.toThrow("did not grant plan usage");
      provider.wrongNonce();
      await expect(provider.plan.connect("third")).rejects.toThrow("verify the authorized ChatGPT identity");
      expect(await provider.plan.status()).toMatchObject({ account: "default", accounts: ["default", "work"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registry keeps plan usage and account controls on the CLI", () => {
    for (const name of ["ask_plan", "chatgpt_connect", "chatgpt_status", "chatgpt_use", "chatgpt_models", "chatgpt_disconnect"])
      expect(getOp(name)?.localOnly).toBe(true);
  });

  test("ask-plan retrieves indexed context before requiring a connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "okb-chatgpt-brain-"));
    try {
      await writeConcept(root, {
        id: "notes/library", type: "note", title: "Neighborhood library", description: "Planning notes",
      });
      let stderr = "";
      const cli = (...args: string[]) => runCli(["--bundle", root, ...args], {
        out: () => {}, err: (text) => { stderr += text; },
      });
      expect(await cli("index")).toBe(0);
      expect(await cli("ask-plan", "neighborhood library")).toBe(1);
      expect(stderr).toContain("Connect a ChatGPT plan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
