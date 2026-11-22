import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { openInBrowser } from "../browser.ts";
import { dataDir } from "../config.ts";
import { ensureExtensionCapableSqlite } from "../engine/custom-sqlite.ts";
import { AiError, type ChatMessage } from "./recipes.ts";

const AUTH = "https://auth.openai.com";
const API = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const NEW_CLIENT = "dynamic_agent_client";
const CALLBACK = "/auth/callback";
export const CHATGPT_USAGE = "https://chatgpt.com/settings/usage";

type Json = Record<string, unknown>;

interface Grant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

interface Profile {
  clientId: string;
  identity?: { subject: string; email?: string };
  grant?: Grant;
}

interface State {
  hostId: string;
  active: string;
  profiles: [string, Profile][];
}

export interface ChatgptPlanStatus {
  connected: boolean;
  sharing: boolean;
  account: string | null;
  email: string | null;
  accounts: string[];
}

export interface ChatgptPlanAnswer {
  model: string;
  text: string;
}

interface PlanModel {
  slug: string;
  name: string;
}

export interface ChatgptPlan {
  connect(account?: string): Promise<ChatgptPlanStatus>;
  status(): Promise<ChatgptPlanStatus>;
  use(account: string): Promise<ChatgptPlanStatus>;
  disconnect(account?: string): Promise<{ revoked: boolean }>;
  models(account?: string): Promise<PlanModel[]>;
  complete(messages: ChatMessage[], model?: string, account?: string): Promise<ChatgptPlanAnswer>;
}

export interface PlanOptions {
  path?: string;
  fetch?: typeof fetch;
  authorize?: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
}

function store(path: string): Database {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
      throw new AiError("ChatGPT credentials require a private local database (0600 on Unix)");
    ensureExtensionCapableSqlite();
    const db = new Database(path, { readwrite: true });
    try {
      db.exec("PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS plans (state TEXT NOT NULL)");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError("Could not open the local ChatGPT account store");
  }
}

/** A database write lease serializes refresh-token rotation across CLI processes. */
async function withState<T>(path: string, edit: boolean, action: (state: State) => T | Promise<T>): Promise<T> {
  const db = store(path);
  try {
    if (edit) db.exec("BEGIN IMMEDIATE");
    const row = db.query<{ state: string }, []>("SELECT state FROM plans").get();
    const state: State = row ? JSON.parse(row.state) : { hostId: `urn:uuid:${randomUUID()}`, active: "", profiles: [] };
    const result = await action(state);
    if (edit) {
      db.exec("DELETE FROM plans");
      db.query("INSERT INTO plans VALUES (?)").run(JSON.stringify(state));
      db.exec("COMMIT");
    }
    return result;
  } catch (error) {
    if (error instanceof AiError) throw error;
    if ((error as { code?: string }).code === "SQLITE_BUSY")
      throw new AiError("Another okb command is updating the ChatGPT account. Try again shortly.");
    throw new AiError("Could not use the local ChatGPT account store");
  } finally {
    db.close();
  }
}

const profileOf = (state: State, label = state.active) => state.profiles.find(([name]) => name === label)?.[1];

function summarize(state: State): ChatgptPlanStatus {
  const active = profileOf(state);
  return {
    connected: Boolean(active?.grant),
    sharing: active?.grant?.scopes.includes(PLAN_SCOPE) ?? false,
    account: state.active || null,
    email: active?.identity?.email ?? null,
    accounts: state.profiles.map(([name]) => name),
  };
}

const emptyStatus = summarize({ hostId: "", active: "", profiles: [] });
const randomProof = () => randomBytes(32).toString("base64url");

async function authorization(
  state: State,
  profile: Profile | undefined,
  open: NonNullable<PlanOptions["authorize"]>,
  signal?: AbortSignal,
): Promise<{ code: string; clientId: string; verifier: string; nonce: string; redirectUri: string }> {
  const verifier = randomProof();
  const nonce = randomProof();
  const proof = randomProof();
  const callback = Promise.withResolvers<{ code: string; clientId: string }>();
  // The browser helper can throw before we begin awaiting the callback.
  void callback.promise.catch(() => {});
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const q = url.searchParams;
      if (request.method !== "GET" || url.pathname !== CALLBACK || q.get("state") !== proof)
        return new Response("Invalid sign-in callback", { status: 400 });
      const code = q.get("code");
      const clientId = q.get("client_id") ?? profile?.clientId;
      if (q.has("error") || !code || !clientId || clientId === NEW_CLIENT ||
          (profile && clientId !== profile.clientId)) {
        callback.reject(new AiError("ChatGPT sign-in was denied or returned an invalid registration"));
        return new Response("Sign-in did not complete. Return to okbrain.", { status: 400 });
      }
      callback.resolve({ code, clientId });
      return new Response("Authorization received. You can return to okbrain.", {
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      });
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK}`;
  const url = new URL(`${AUTH}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: profile?.clientId ?? NEW_CLIENT,
    ...(profile ? {} : { agent_name_hint: "okbrain" }),
    ext_agent_host_id: state.hostId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
    resource: API,
    state: proof,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  const timer = setTimeout(() => callback.reject(new AiError("ChatGPT sign-in timed out")), 180_000);
  const abort = () => callback.reject(new AiError("ChatGPT sign-in was cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new AiError("ChatGPT sign-in was cancelled");
    await open(url.toString());
    return { ...(await callback.promise), verifier, nonce, redirectUri };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    void server.stop();
  }
}

function parseGrant(data: Json, prior?: Grant): Grant {
  const { access_token, refresh_token, expires_in, token_type, scope } = data;
  if (typeof access_token !== "string" || !access_token || typeof expires_in !== "number" ||
      !Number.isFinite(expires_in) || expires_in <= 0 ||
      typeof token_type !== "string" || token_type.toLowerCase() !== "bearer")
    throw new AiError("OpenAI did not return a valid ChatGPT plan grant");
  const refreshToken = typeof refresh_token === "string" && refresh_token ? refresh_token : prior?.refreshToken;
  if (!refreshToken) throw new AiError("OpenAI did not return a renewable ChatGPT session");
  return {
    accessToken: access_token,
    refreshToken,
    expiresAt: Date.now() + expires_in * 1_000,
    scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : prior?.scopes ?? [],
  };
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) throw new AiError("ChatGPT plan returned an empty response stream");
  const events = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: 2_000_000 }));
  let text = "";
  try {
    for await (const { data } of events) {
      if (data === "[DONE]") break;
      const event = JSON.parse(data);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
      if (text.length > 2_000_000) throw new AiError("ChatGPT plan response exceeded the local text limit");
      if (event.type === "response.completed") {
        if (text.trim()) return text;
        throw new AiError("ChatGPT plan response completed without text");
      }
      if (event.type === "response.failed" || event.type === "error") {
        const code = event.response?.error?.code ?? event.code;
        if (code === "subscription_sharing_usage_limit_exceeded" || code === "subscription_sharing_usage_unavailable")
          throw new AiError(`ChatGPT plan use is limited or unavailable. Check ${CHATGPT_USAGE}`);
        throw new AiError("ChatGPT plan inference failed");
      }
      if (event.type === "response.incomplete") throw new AiError("ChatGPT plan response was incomplete");
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError("ChatGPT plan response stream was interrupted");
  }
  throw new AiError("ChatGPT plan response stream ended before completion");
}

export function createChatgptPlan(options: PlanOptions = {}): ChatgptPlan {
  const path = options.path ?? join(dataDir(), "chatgpt", "accounts.db");
  const transport = options.fetch ?? fetch;
  const open = options.authorize ?? ((url: string) => {
    process.stderr.write(`Continue with ChatGPT in your browser:\n${url}\n`);
    if (process.platform !== "win32") openInBrowser(url);
  });
  const jwks = createRemoteJWKSet(new URL(`${AUTH}/.well-known/jwks.json`), {
    [customFetch]: (url, init) => transport(url, { ...init, redirect: "error" }),
  });

  async function request(url: string, init: RequestInit = {}, timeout = 20_000): Promise<Response> {
    try {
      return await transport(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new AiError("Could not reach OpenAI for ChatGPT plan usage");
    }
  }

  async function json(response: Response): Promise<Json> {
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new AiError("ChatGPT plan access was denied. Reconnect the selected account.");
      if (response.status === 429) throw new AiError(`ChatGPT plan limit reached. Check ${CHATGPT_USAGE}`);
      throw new AiError(`ChatGPT plan request failed (HTTP ${response.status})`);
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new AiError("OpenAI returned an invalid ChatGPT plan response");
    return data as Json;
  }

  async function token(params: Record<string, string>): Promise<Json> {
    return json(await request(`${AUTH}/api/accounts/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ ...params, resource: API }),
    }));
  }

  const disconnected = () => new AiError("Connect a ChatGPT plan from Accounts or `okb chatgpt connect` first");

  async function access(account?: string): Promise<string> {
    if (!existsSync(path)) throw disconnected();
    const current = (state: State) => {
      if (account !== undefined && state.active !== account)
        throw new AiError("The active ChatGPT account changed. Preview sources again.");
      const profile = profileOf(state);
      if (!profile?.grant) throw disconnected();
      if (!profile.grant.scopes.includes(PLAN_SCOPE))
        throw new AiError(`ChatGPT plan permission is unavailable. Check ${CHATGPT_USAGE}`);
      return profile as Profile & { grant: Grant };
    };
    const fresh = (grant: Grant) => grant.expiresAt - Date.now() > 60_000;
    const { grant, label } = await withState(path, false, (state) => ({ grant: current(state).grant, label: state.active }));
    if (fresh(grant)) return grant.accessToken;
    const refreshed = await withState(path, true, async (state) => {
      if (state.active !== label) throw new AiError("The active ChatGPT account changed. Retry the request.");
      const profile = current(state);
      if (fresh(profile.grant)) return profile.grant;
      profile.grant = parseGrant(await token({
        grant_type: "refresh_token",
        client_id: profile.clientId,
        refresh_token: profile.grant.refreshToken,
      }), profile.grant);
      return profile.grant;
    });
    if (!refreshed.scopes.includes(PLAN_SCOPE))
      throw new AiError(`ChatGPT plan permission is unavailable. Check ${CHATGPT_USAGE}`);
    return refreshed.accessToken;
  }

  async function models(accessToken: string): Promise<PlanModel[]> {
    const data = await json(await request(`${API}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }));
    if (!Array.isArray(data.models)) throw new AiError("OpenAI returned an invalid ChatGPT plan model list");
    return data.models.flatMap((model): PlanModel[] =>
      model?.visibility === "list" && typeof model.slug === "string" && model.slug
        ? [{ slug: model.slug, name: typeof model.display_name === "string" ? model.display_name : model.slug }]
        : [],
    );
  }

  return {
    status: async () => existsSync(path) ? withState(path, false, summarize) : emptyStatus,
    async connect(account) {
      if (account !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(account))
        throw new AiError("ChatGPT account labels must be 1–40 letters, digits, underscores, or hyphens");
      // Persist the host id before authorization, including when the first sign-in is interrupted.
      await withState(path, true, () => undefined);
      return withState(path, true, async (state) => {
        const label = account ?? (state.active || "default");
        const prior = profileOf(state, label);
        const { code, clientId, verifier, nonce, redirectUri } = await authorization(state, prior, open, options.signal);
        const data = await token({
          grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier,
          redirect_uri: redirectUri,
        });
        let identity: NonNullable<Profile["identity"]>;
        try {
          if (typeof data.id_token !== "string") throw new Error();
          const { payload } = await jwtVerify(data.id_token, jwks, {
            issuer: AUTH, audience: clientId, requiredClaims: ["exp", "sub", "nonce"], algorithms: ["RS256"],
          });
          if (payload.nonce !== nonce || !payload.sub || (prior?.identity && payload.sub !== prior.identity.subject))
            throw new Error();
          identity = { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
        } catch {
          throw new AiError("Could not verify the authorized ChatGPT identity");
        }
        const grant = parseGrant(data);
        if (!grant.scopes.includes(PLAN_SCOPE))
          throw new AiError(`ChatGPT sign-in did not grant plan usage. Check ${CHATGPT_USAGE}`);
        if (options.signal?.aborted) throw new AiError("ChatGPT sign-in was cancelled");
        const entry = state.profiles.find(([name]) => name === label);
        const profile = { clientId, identity, grant };
        if (entry) entry[1] = profile;
        else state.profiles.push([label, profile]);
        state.active = label;
        return summarize(state);
      });
    },
    use: (account) => withState(path, true, (state) => {
      if (!profileOf(state, account)) throw new AiError(`No saved ChatGPT account named ${account}`);
      state.active = account;
      return summarize(state);
    }),
    async disconnect(account) {
      if (!existsSync(path)) return { revoked: true };
      return withState(path, true, async (state) => {
        if (account !== undefined && state.active !== account)
          throw new AiError("The active ChatGPT account changed. Select the account to sign out.");
        const profile = profileOf(state);
        if (!profile?.grant) return { revoked: true };
        let revoked = false;
        for (const delay of [0, 300, 900]) {
          if (delay) await Bun.sleep(delay);
          try {
            const response = await request(`${AUTH}/api/accounts/oauth/revoke`, {
              method: "POST",
              body: new URLSearchParams({
                token: profile.grant.refreshToken, token_type_hint: "refresh_token", client_id: profile.clientId,
              }),
            }, 7_000);
            revoked = response.ok;
            if (revoked || response.status < 500) break;
          } catch {
            // Local credentials are cleared even if OpenAI is unreachable.
          }
        }
        delete profile.grant;
        return { revoked };
      });
    },
    models: async (account) => models(await access(account)),
    async complete(messages, model, account) {
      const accessToken = await access(account);
      const selected = model ?? (await models(accessToken))[0]?.slug;
      if (!selected) throw new AiError("No text models are available for the selected ChatGPT plan");
      const response = await request(`${API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: selected, input: messages, stream: true, store: false }),
      }, 120_000);
      if (!response.ok) await json(response);
      return { model: selected, text: await responseText(response) };
    },
  };
}
