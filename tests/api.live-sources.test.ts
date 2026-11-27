import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { createLiveSources } from "../src/core/ingest/live-sources.ts";
import type { ConnectedSourceProvider, SourceUploadResult } from "../src/core/ingest/personal-sources.ts";
import { readConceptPermissive } from "../src/core/okf/bundle.ts";

const token = "live-source-test-owner";
const credentials = { drive: "drive.test-credential-which-is-private", slack: "xoxb-test-private-slack-key", linear: "lin_api_test_private_linear_api_key" };
const drive = { id: "document_ID123", title: "Project handoff", text: "Original Google Drive text\n~~~\n![Pixel](https://private.example/pixel)" };
const resourceKey = "0-public-sharing-key-fixture";
const channel = "C012345678";
const slackLink = `https://example.slack.com/archives/${channel}/p1712345678000123`;
const threadLink = `${slackLink}?thread_ts=1712345677.000000&cid=${channel}`;
const linear = { id: "11111111-2222-3333-4444-555555555555", identifier: "OPS-42", title: "Selected issue", description: "Original Linear issue", url: "https://linear.app/example/issue/OPS-42/selected-issue" };

function route(api: ApiServer, provider: ConnectedSourceProvider, action: string, body?: unknown, headers: Record<string, string> = { "x-okb-token": token }) {
  return fetch(api.url + `api/personal/sources/${provider}/${action}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function received<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return ((await response.json()) as { result: T }).result;
}

test("selected live items use fixed provider reads and save exactly the previewed private drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-live-sources-"));
  const brain = join(root, "brain");
  const directory = join(root, "connections");
  await mkdir(brain);
  let documentText = drive.text;
  let slackCanonical = slackLink;
  const calls: string[] = [];
  const api = createApiServer({ bundle: brain, port: 0, token, liveSources: { directory, fetch: async (url, request) => {
    const auth = new Headers(request.headers).get("authorization");
    expect(request.redirect).toBe("error");
    calls.push(url.href);
    if (url.origin === "https://www.googleapis.com") {
      expect(auth).toBe(`Bearer ${credentials.drive}`);
      expect(new Headers(request.headers).get("x-goog-drive-resource-keys")).toBe(`${drive.id}/${resourceKey}`);
      if (url.pathname.endsWith("/export")) {
        expect(url.searchParams.get("mimeType")).toBe("text/plain");
        return new Response(documentText);
      }
      expect(url.searchParams.get("fields")).toBe("id,name,mimeType,trashed,capabilities(canDownload)");
      return Response.json({ id: drive.id, name: drive.title, mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } });
    }
    if (url.origin === "https://slack.com") {
      expect(auth).toBe(`Bearer ${credentials.slack}`);
      expect(url.searchParams.get("channel")).toBe(channel);
      if (url.pathname.endsWith("/chat.getPermalink")) return Response.json({ ok: true, permalink: slackCanonical });
      expect(url.searchParams.get("oldest")).toBe("1712345678.000123");
      expect(url.searchParams.get("latest")).toBe("1712345678.000123");
      expect(url.searchParams.get("limit")).toBe("1");
      if (url.pathname.endsWith("/conversations.replies")) expect(url.searchParams.get("ts")).toBe("1712345677.000000");
      else expect(url.pathname).toBe("/api/conversations.history");
      return Response.json({ ok: true, messages: [{ ts: "1712345678.000123", text: "Selected Slack message" }, { ts: "1712345678.000124", text: "Unselected text" }] });
    }
    expect(url.href).toBe("https://api.linear.app/graphql");
    expect(request.method).toBe("POST");
    expect(auth).toBe(credentials.linear);
    const query = JSON.parse(String(request.body));
    expect(query.variables).toEqual({ id: linear.identifier });
    expect(query.query).toContain("issue(id: $id)");
    return Response.json({ data: { issue: linear } });
  } } });
  try {
    expect((await route(api, "drive", "status", undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await route(api, "drive", "connect", { token: credentials.drive })).status).toBe(400);
    for (const provider of ["drive", "slack", "linear"] as const) {
      expect(await received(await route(api, provider, "status"))).toEqual({ connected: false });
      expect(await received(await route(api, provider, "connect", { token: credentials[provider], allow: true }))).toEqual({ connected: true });
      if (process.platform !== "win32") expect((await stat(join(directory, provider))).mode & 0o077).toBe(0);
    }
    expect(calls).toEqual([]);
    expect((await route(api, "drive", "preview", { item: "https://untrusted.example/doc", name: "Drive" })).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await route(api, "slack", "preview", { item: slackLink.replace("example.slack.com", "other.slack.com"), name: "Slack" })).status).toBe(409);
    expect(calls).toHaveLength(1);

    const cases = [
      { provider: "drive", name: "Drive", item: `https://docs.google.com/document/d/${drive.id}/edit?resourcekey=${resourceKey}`, content: drive.text, resource: `https://docs.google.com/document/d/${drive.id}/edit` },
      { provider: "slack", name: "Slack", item: slackLink, content: "Selected Slack message", resource: slackLink },
      { provider: "linear", name: "Linear", item: linear.url, content: linear.description, resource: linear.url },
    ] as const;
    for (const current of cases) {
      const { previewId, rows, markdown } = await received<{ previewId: string; rows: { id: string }[]; markdown: string }>(
        await route(api, current.provider, "preview", { item: current.item, name: current.name }));
      expect(markdown).toContain(current.content);
      expect(markdown).not.toContain("Unselected text");
      expect(markdown).not.toContain(credentials[current.provider]);
      expect(JSON.stringify({ rows, markdown })).not.toContain(resourceKey);
      const note = rows[0]!.id;
      const count = calls.length;
      if (current.provider === "drive") documentText = "Edited after preview";
      const saved = await received<SourceUploadResult>(await route(api, current.provider, "import", { previewId }));
      expect(saved.imported).toEqual([note]);
      expect(calls).toHaveLength(count);
      const { doc } = await readConceptPermissive(brain, note);
      expect(doc.body).toBe(markdown);
      expect(doc.frontmatter).toMatchObject({ status: "draft", resource: current.resource, sources: [{ id: current.provider, resource: current.resource }] });
      expect((await received<SourceUploadResult>(await route(api, current.provider, "import", { previewId }))).imported).toEqual([note]);
    }
    slackCanonical = threadLink;
    const reply = await received<{ markdown: string }>(await route(api, "slack", "preview", { item: threadLink, name: "Slack" }));
    expect(reply.markdown).toContain("Selected Slack message");
    const history = await fetch(api.url + "api/personal/sources/history", { headers: { "x-okb-token": token } });
    expect(await received<{ kind: string }[]>(history)).toEqual(expect.arrayContaining(cases.map(({ provider }) => expect.objectContaining({ kind: provider }))));
    const readonly = createApiServer({ bundle: brain, port: 0, token, readonly: true, liveSources: { directory } });
    try {
      expect(await received(await route(readonly, "drive", "status"))).toEqual({ connected: true });
      expect((await route(readonly, "drive", "preview", { item: drive.id, name: "Drive" })).status).toBe(403);
      expect((await route(readonly, "drive", "disconnect", {})).status).toBe(403);
    } finally { await readonly.stop(); }
    expect(await received(await route(api, "drive", "disconnect", {}))).toEqual({ connected: false });
    expect(await Bun.file(join(directory, "drive")).exists()).toBe(false);
  } finally {
    await api.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test("live receipts reject another brain and replaced credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-live-receipts-"));
  const first = join(root, "one");
  const second = join(root, "two");
  await Promise.all([mkdir(first), mkdir(second)]);
  const live = createLiveSources({ directory: join(root, "connections"), fetch: async () => Response.json({ data: { issue: linear } }) });
  const connector = live.connector("linear");
  try {
    await connector.connect({ token: credentials.linear, allow: true });
    const preview = await connector.preview(first, { item: linear.identifier, name: "Linear" });
    await expect(connector.commit(second, preview.previewId)).rejects.toThrow("Preview the item again");
    await connector.connect({ token: credentials.linear + "-replacement", allow: true });
    await expect(connector.commit(first, preview.previewId)).rejects.toThrow("Preview the item again");
  } finally {
    live.close();
    await rm(root, { force: true, recursive: true });
  }
});
