import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pinnedEvaluationCheckout } from "../src/core/coding/evaluation-rubric.ts";

const ownerToken = "local-fixture-owner";
const branch = "research-notes";
const login = "fixture-user";
const token = "github_pat_local_fixture_0123456789abcdef";
const wrongToken = "github_pat_wrong_fixture_0123456789abcdef";
const basic = (value: string) => "Basic " + Buffer.from(`${login}:${value}`).toString("base64");
const github = (repository: string) => `https://github.com/fixture/${repository}.git`;
const project = join(import.meta.dir, "..");
const cert = join(import.meta.dir, "fixtures", "restore-github-test-cert.pem");
const key = join(import.meta.dir, "fixtures", "restore-github-test-key.pem");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, "missing-git-config") } }).trim();
}

async function makeRepository(root: string, gitRoot: string, name: string, note: string, privateHistory = false) {
  const working = join(root, `source-${name}`);
  const remote = join(gitRoot, "fixture", `${name}.git`);
  await mkdir(join(working, "notes"), { recursive: true });
  await mkdir(remote, { recursive: true });
  git(working, "init", "--quiet", "--initial-branch", branch);
  git(working, "config", "core.autocrlf", "false");
  git(working, "config", "user.name", "Restore Fixture");
  git(working, "config", "user.email", "restore@example.test");
  await writeFile(join(working, "index.md"), "---\nokf_version: '0.2'\n---\n# Restored brain\n");
  await writeFile(join(working, "notes", "restored.md"), note);
  git(working, "add", "--", "index.md", "notes/restored.md");
  git(working, "commit", "--quiet", "-m", "Fixture notes");
  if (privateHistory) {
    await mkdir(join(working, "db_only"));
    await writeFile(join(working, "db_only", "fixture.md"), "---\ntype: note\ntitle: Historical fixture\n---\nPrivate fixture bytes.\n");
    git(working, "add", "--", "db_only/fixture.md");
    git(working, "commit", "--quiet", "-m", "Record a private test fixture");
    git(working, "rm", "--quiet", "--", "db_only/fixture.md");
    git(working, "commit", "--quiet", "-m", "Remove the private test fixture");
  }
  git(remote, "init", "--bare", "--quiet");
  // The remote's default HEAD is deliberately absent. Restore must select the requested branch.
  git(working, "push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`);
  return git(working, "rev-parse", "HEAD");
}

async function smartGit(req: Request, url: URL, root: string): Promise<Response> {
  const request = await req.arrayBuffer();
  const backend = Bun.spawn(["git", "http-backend"], {
    cwd: root,
    stdin: request.byteLength ? new Blob([request]) : "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "missing-git-config"),
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(request.byteLength), HTTP_GIT_PROTOCOL: req.headers.get("git-protocol") ?? "" },
  });
  const [bytes, stderr, exit] = await Promise.all([
    new Response(backend.stdout).arrayBuffer(), new Response(backend.stderr).text(), backend.exited,
  ]);
  if (exit !== 0) throw new Error(`Git fixture backend exited ${exit}: ${stderr}`);
  const raw = Buffer.from(bytes);
  const blank = raw.indexOf("\r\n\r\n");
  const end = blank === -1 ? raw.indexOf("\n\n") : blank;
  if (end === -1) throw new Error("Git fixture backend omitted response headers.");
  const headers = new Headers();
  let status = 200;
  for (const line of raw.subarray(0, end).toString().split(/\r?\n/u)) {
    const split = line.indexOf(":");
    if (split === -1) throw new Error("Git fixture backend returned an invalid response header.");
    const name = line.slice(0, split).toLowerCase();
    const value = line.slice(split + 1).trim();
    if (name === "status") status = Number(value.split(" ")[0]);
    else headers.append(name, value);
  }
  return new Response(raw.subarray(end + (blank === -1 ? 2 : 4)), { status, headers });
}

/** Git keeps the real github.com TLS hostname; CONNECT can reach only the fixture. */
async function fixtureProxy(port: number) {
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let chunks = Buffer.alloc(0);
    client.on("data", function handshake(data) {
      chunks = Buffer.concat([chunks, typeof data === "string" ? Buffer.from(data) : data]);
      if (chunks.length > 8192) return client.destroy();
      const end = chunks.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", handshake);
      if (!/^CONNECT github\.com:443 HTTP\/1\.[01]\r\n/u.test(chunks.toString("ascii", 0, end + 2))) {
        return client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
      client.pause();
      const upstream = connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const tail = chunks.subarray(end + 4);
        if (tail.length) upstream.write(tail);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

async function startRestoreApp(root: string, bundle: string, proxy: string) {
  const script = `
    import { createApiServer } from "./src/api.ts";
    const { bundle, token } = JSON.parse(process.argv.at(-1));
    const api = createApiServer({ bundle, token, port: 0 });
    process.stdout.write(api.url + "\\n");
    await Bun.stdin.text();
    await api.stop();
  `;
  const config = join(root, "config");
  const data = join(root, "data");
  const child = Bun.spawn([process.execPath, "-e", script, "--", JSON.stringify({ bundle, token: ownerToken })], {
    cwd: project,
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
    env: { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config, XDG_DATA_HOME: data, LOCALAPPDATA: data,
      HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy,
      NO_PROXY: "", no_proxy: "", GIT_SSL_CAINFO: cert },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The restore API stopped before returning its address.");
      line += decoder.decode(value, { stream: true });
    }
    const url = line.trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/u.test(url)) throw new Error("Unexpected restore API address.");
    return { url, async stop() { child.stdin.end(); await child.exited; } };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    reader.releaseLock();
    clearTimeout(timer);
  }
}

interface RestoreResult {
  brain: { name: string; path: string; readonly: false };
  path: string;
  origin: string;
  branch: string;
  commit: string;
  credentialSaved?: boolean;
}

test("restores public and private GitHub brains over real HTTPS and leaves existing siblings intact", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "okb-restore-https-")));
  const bundle = join(root, "starter");
  const parent = join(root, "restored-brains");
  const otherParent = join(root, "other-parent");
  const gitRoot = join(root, "git-root");
  const publicNote = "---\ntype: note\ntitle: Restored public note\n---\nExact public bytes.\n";
  const privateNote = "---\ntype: note\ntitle: Restored private repository note\n---\nExact private repository bytes.\n";
  const seen: { repository: string; auth: string | null }[] = [];
  let tls: ReturnType<typeof Bun.serve> | undefined;
  let proxy: Awaited<ReturnType<typeof fixtureProxy>> | undefined;
  let api: Awaited<ReturnType<typeof startRestoreApp>> | undefined;
  try {
    for (const path of [bundle, parent, otherParent]) await mkdir(path);
    const publicCommit = await makeRepository(root, gitRoot, "open", publicNote);
    const privateCommit = await makeRepository(root, gitRoot, "restricted", privateNote);
    await makeRepository(root, gitRoot, "history", publicNote, true);
    await makeRepository(root, gitRoot, "private-note", publicNote.replace("type: note\n", "type: note\ndb_only: true\n"));
    expect(git(join(gitRoot, "fixture", "history.git"), "ls-tree", "-r", "--name-only", branch)).not.toContain("db_only/");
    // Test-only key and trust anchor used exclusively through the closed loopback proxy.
    tls = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, async fetch(req) {
      const url = new URL(req.url);
      const route = /^\/fixture\/(open|restricted|redirect|history|private-note)\.git\/(info\/refs|git-upload-pack)$/u.exec(url.pathname);
      if (!route || (route[2] === "info/refs" ? req.method !== "GET" || url.search !== "?service=git-upload-pack" : req.method !== "POST"))
        return new Response("Not found", { status: 404 });
      const repository = route[1]!;
      const auth = req.headers.get("authorization");
      seen.push({ repository, auth });
      if (repository === "redirect") return Response.redirect(github("restricted") + "/info/refs?service=git-upload-pack", 307);
      if (repository === "restricted" && auth !== basic(token)) {
        return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="fixture"' } });
      }
      return smartGit(req, url, gitRoot);
    } });
    proxy = await fixtureProxy(tls.port!);
    api = await startRestoreApp(root, bundle, proxy.url);
    const request = (path: string, body?: unknown, brain?: string) => fetch(new URL(path, api!.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-okb-token": ownerToken, ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(brain ? { "x-okb-brain": brain } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const restore = (name: string, repository: string, options: Record<string, unknown> = {}) => request("api/brains", {
      action: "restore", name, parent, url: github(repository), branch, ...options,
    });
    const success = async (response: Response): Promise<RestoreResult> => {
      const body = await response.json() as { result: RestoreResult; error?: string };
      if (!response.ok) throw new Error(`Restore failed (${response.status}): ${body.error}`);
      expect(JSON.stringify(body)).not.toContain(token);
      expect(JSON.stringify(body)).not.toContain(basic(token));
      return body.result;
    };
    const expectFailure = async (response: Response) => {
      expect(response.ok).toBe(false);
      const raw = await response.text();
      expect(raw).not.toContain(token);
      expect(raw).not.toContain(wrongToken);
      expect(raw).not.toContain(basic(token));
      expect(raw).not.toContain(basic(wrongToken));
      return raw;
    };

    await expectFailure(await restore("missing-auth", "restricted"));
    await expectFailure(await restore("wrong-auth", "restricted", { login, token: wrongToken, saveCredential: true }));
    expect(await readdir(parent)).toEqual([]);
    expect(seen.some((row) => row.repository === "restricted" && row.auth === null)).toBe(true);
    expect(seen.some((row) => row.repository === "restricted" && row.auth === basic(wrongToken))).toBe(true);

    const redirectStart = seen.length;
    await expectFailure(await restore("redirected", "redirect", { login, token }));
    expect(seen.length).toBeGreaterThan(redirectStart);
    expect(seen.slice(redirectStart).every(({ repository, auth }) => repository === "redirect" && auth === basic(token))).toBe(true);
    expect(await readdir(parent)).toEqual([]);

    expect(await expectFailure(await restore("private-history", "history"))).toContain("Git history contains a db_only directory");
    expect(seen.some(({ repository }) => repository === "history")).toBe(true);
    expect(await expectFailure(await restore("private-tip", "private-note"))).toContain("The selected branch tracks private notes");
    expect(await readdir(parent)).toEqual([]);

    const existing = join(parent, "public-brain");
    await mkdir(existing);
    await writeFile(join(existing, "sentinel.txt"), "Keep the current sibling.\n");
    const restricted = await success(await restore("private-brain", "restricted", { login, token, saveCredential: true }));
    const open = await success(await restore("public-brain", "open"));
    expect(restricted.credentialSaved).toBe(true);
    expect(open.credentialSaved).toBe(false);
    expect(seen.some((row) => row.repository === "restricted" && row.auth === basic(token))).toBe(true);
    expect(seen.filter((row) => row.repository === "open").length).toBeGreaterThan(0);
    expect(seen.filter((row) => row.repository === "open").every((row) => row.auth === null)).toBe(true);
    for (const [result, name, repo, commit, note, saved] of [
      [restricted, "private-brain", "restricted", privateCommit, privateNote, true],
      [open, "public-brain", "open", publicCommit, publicNote, false],
    ] as const) {
      expect(result).toMatchObject({ brain: { name, path: result.path, readonly: false }, origin: github(repo), branch, commit });
      expect(dirname(result.path)).toBe(parent);
      expect(basename(result.path)).toStartWith(`okbrain-${name}-`);
      expect(await readFile(join(result.path, "notes", "restored.md"), "utf8")).toBe(note);
      expect(git(result.path, "rev-parse", "HEAD")).toBe(commit);
      expect(git(result.path, "branch", "--show-current")).toBe(branch);
      expect(git(result.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).toBe("origin/" + branch);
      expect(git(result.path, "remote", "get-url", "origin")).toBe(github(repo));
      expect(git(result.path, "status", "--porcelain")).toBe("");
      const gitConfig = await readFile(join(result.path, ".git", "config"), "utf8");
      expect(gitConfig).not.toContain(token);
      expect(gitConfig).not.toContain(basic(token));
      const credential = await request("api/brains/sync-github", { action: "status" }, name);
      expect(credential.ok).toBe(true);
      const credentialBody = await credential.text();
      expect(credentialBody).not.toContain(token);
      expect(JSON.parse(credentialBody)).toMatchObject({ result: { repository: `fixture/${repo}`, hasToken: saved,
        savedFor: saved ? `fixture/${repo}` : null } });
      const selected = await request("api/brains", undefined, name);
      expect(selected.ok).toBe(true);
      const selectedBody = await selected.json() as { brains: unknown[] };
      expect(selectedBody.brains).toContainEqual(expect.objectContaining({ name, exists: true, active: true }));
      const status = await request("api/status", undefined, name);
      expect(status.ok).toBe(true);
      expect(await status.json()).toMatchObject({ hasIndex: true });
      const read = await request("api/op/read_concept", { id: "notes/restored" }, name);
      expect(read.ok).toBe(true);
      expect(await read.text()).toContain(note.includes("Exact public") ? "Exact public bytes." : "Exact private repository bytes.");
    }

    expect(await readdir(existing)).toEqual(["sentinel.txt"]);
    expect(await readFile(join(existing, "sentinel.txt"), "utf8")).toBe("Keep the current sibling.\n");
    const duplicate = await restore("public-brain", "open", { parent: otherParent });
    expect(duplicate.status).toBe(409);
    await expectFailure(duplicate);
    expect(await readdir(otherParent)).toEqual([]);
    expect(await readFile(join(open.path, "notes", "restored.md"), "utf8")).toBe(publicNote);
    const listed = await request("api/brains");
    const registry = await listed.json() as { brains: { name: string }[] };
    expect(registry.brains.map(({ name }) => name).sort()).toEqual(["private-brain", "public-brain"]);
  } finally {
    await api?.stop();
    await proxy?.stop();
    await tls?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("the local operator prepares a GitHub Coding checkout with transient auth and registers it separately", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "okb-coding-github-https-")));
  const bundle = join(root, "brain");
  const workspaceMount = join(root, "other-brain");
  const gitRoot = join(root, "git-root");
  const checkouts = join(root, "data", "okbrain", "coding-projects", "checkouts");
  const code = "export const codingCheckoutFixture = true;\n";
  const seen: { repository: string; auth: string | null }[] = [];
  const fetchStarted = Promise.withResolvers<void>();
  const fetchRelease = Promise.withResolvers<void>();
  let tls: ReturnType<typeof Bun.serve> | undefined;
  let proxy: Awaited<ReturnType<typeof fixtureProxy>> | undefined;
  let api: Awaited<ReturnType<typeof startRestoreApp>> | undefined;
  const request = (path: string, body?: unknown, options: { authorization?: string; brain?: string; anonymous?: boolean } = {}) =>
    fetch(new URL(`api/${path}`, api!.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(options.anonymous ? {} : options.authorization ? { authorization: `Bearer ${options.authorization}` } : { "x-okb-token": ownerToken }),
        ...(body === undefined ? {} : { "content-type": "application/json" }), ...(options.brain ? { "x-okb-brain": options.brain } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(18_000),
    });
  const prepare = (body: Record<string, unknown>, options?: Parameters<typeof request>[2]) => request("coding/github-checkouts", body, options);
  const result = async <T,>(response: Response): Promise<T> => {
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(basic(token));
    if (!response.ok) throw new Error(`Coding fixture request failed (${response.status}): ${body}`);
    return JSON.parse(body).result as T;
  };

  try {
    await Promise.all([mkdir(bundle), mkdir(workspaceMount)]);
    await makeRepository(root, gitRoot, "coding-workspace", "---\ntype: note\ntitle: Removed fixture\n---\nOld bytes.\n");
    const source = join(root, "source-coding-workspace");
    git(source, "rm", "--", "index.md", "notes/restored.md");
    await mkdir(join(source, "src"));
    await writeFile(join(source, "src", "fixture.ts"), code);
    git(source, "add", "--", "src/fixture.ts");
    git(source, "commit", "--quiet", "-m", "Publish a coding checkout");
    const commit = git(source, "rev-parse", "HEAD");
    const remote = join(gitRoot, "fixture", "coding-workspace.git");
    git(source, "push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`);
    const unsupportedBranch = "linked-files";
    git(source, "checkout", "-qb", unsupportedBranch);
    await writeFile(join(source, "link-target.txt"), "../outside\n");
    const link = git(source, "hash-object", "-w", "--", "link-target.txt");
    git(source, "update-index", "--add", "--cacheinfo", `120000,${link},fixture-link`);
    git(source, "commit", "--quiet", "-m", "Publish a branch that needs an existing checkout");
    git(source, "push", "--quiet", remote, `refs/heads/${unsupportedBranch}:refs/heads/${unsupportedBranch}`);
    git(source, "-c", "tag.gpgSign=false", "tag", "-a", pinnedEvaluationCheckout.tag, "-m", "Fixture tag for the wrong commit", commit);
    git(source, "push", "--quiet", remote, `refs/tags/${pinnedEvaluationCheckout.tag}`);
    tls = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, async fetch(req) {
      const url = new URL(req.url);
      if (/^\/vitejs\/vite\.git\/(?:info\/refs|git-upload-pack)$/u.test(url.pathname)) {
        const auth = req.headers.get("authorization");
        seen.push({ repository: "vitejs/vite", auth });
        if (auth) return new Response("Unexpected auth", { status: 400 });
        url.pathname = url.pathname.replace("/vitejs/vite.git/", "/fixture/coding-workspace.git/");
        return smartGit(req, url, gitRoot);
      }
      const route = /^\/fixture\/(coding-workspace|coding-redirect)\.git\/(info\/refs|git-upload-pack)$/u.exec(url.pathname);
      if (!route || (route[2] === "info/refs" ? req.method !== "GET" || url.search !== "?service=git-upload-pack" : req.method !== "POST"))
        return new Response("Not found", { status: 404 });
      const repository = route[1]!;
      const auth = req.headers.get("authorization");
      seen.push({ repository, auth });
      if (repository === "coding-redirect")
        return Response.redirect(github("coding-workspace") + "/info/refs?service=git-upload-pack", 307);
      if (auth !== basic(token)) return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="fixture"' } });
      fetchStarted.resolve();
      await fetchRelease.promise;
      return smartGit(req, url, gitRoot);
    } });
    proxy = await fixtureProxy(tls.port!);
    api = await startRestoreApp(root, bundle, proxy.url);
    const mount = await request("brains/mounts", { action: "register", name: "read-only-setup", path: workspaceMount, readonly: true });
    expect(mount.status).toBe(200);
    const baseProject = { title: "Checkout reviewer fixture", workspace: bundle, provider: "openai", model: "gpt-5-mini" };
    const registered = await result<{ id: string }>(await request("coding/projects", baseProject));
    const member = await result<{ token: string }>(await request(`coding/projects/${registered.id}/members`, { name: "reviewer" }));
    const draft = { url: github("coding-workspace"), branch, login, token, approved: true };
    expect((await prepare(draft, { anonymous: true })).status).toBe(401);
    expect((await prepare(draft, { authorization: member.token })).status).toBe(403);
    expect((await prepare(draft, { brain: "read-only-setup" })).status).toBe(403);
    expect((await prepare({ ...draft, approved: false })).status).toBe(400);
    expect((await prepare({ ...draft, workspace: bundle })).status).toBe(400);
    expect((await prepare({ ...draft, url: "https://fixture.invalid/owner/repository.git" })).status).toBe(400);
    expect((await prepare({ ...draft, token: undefined })).status).toBe(400);
    const benchmark = "coding/benchmark-checkout";
    const approval = { approved: true, commit: pinnedEvaluationCheckout.commit };
    const descriptor = await request(benchmark);
    expect(descriptor.headers.get("cache-control")).toBe("no-store");
    expect(await result(descriptor)).toEqual(pinnedEvaluationCheckout);
    expect((await request(benchmark, undefined, { authorization: member.token })).status).toBe(403);
    expect((await request(benchmark, approval, { authorization: member.token })).status).toBe(403);
    expect((await request(benchmark, approval, { brain: "read-only-setup" })).status).toBe(403);
    expect((await request(benchmark, { ...approval, approved: false })).status).toBe(400);
    expect((await request(benchmark, { ...approval, token })).status).toBe(400);
    expect((await request(benchmark, { ...approval, commit })).status).toBe(409);
    expect(seen).toEqual([]);

    const redirected = await prepare({ ...draft, url: github("coding-redirect") });
    expect(redirected.status).toBe(409);
    expect(await redirected.text()).not.toContain(token);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((row) => row.repository === "coding-redirect" && row.auth === basic(token))).toBe(true);
    expect(await readdir(checkouts)).toEqual([]);

    const beforeTag = seen.length;
    const moved = await request(benchmark, approval);
    expect(moved.status).toBe(409);
    expect(await moved.text()).toMatch(/tag.+(?:pin|commit)/iu);
    expect(seen.slice(beforeTag)).not.toEqual([]);
    expect(seen.slice(beforeTag).every((row) => row.repository === "vitejs/vite" && row.auth === null)).toBe(true);
    expect(await readdir(checkouts)).toEqual([]);

    const pending = prepare(draft);
    await Promise.race([fetchStarted.promise, pending.then(() => { throw new Error("Checkout completed before Git received its request."); })]);
    expect((await prepare(draft)).status).toBe(409);
    fetchRelease.resolve();
    const receipt = await result<{ workspace: string; origin: string; repository: string; branch: string; commit: string; reused: boolean }>(await pending);
    expect(receipt).toMatchObject({ origin: draft.url, repository: "fixture/coding-workspace", branch, commit, reused: false });
    expect(dirname(receipt.workspace)).toBe(checkouts);
    expect(await readdir(checkouts)).toEqual([basename(receipt.workspace)]);
    expect((await readdir(receipt.workspace)).sort()).toEqual([".git", "src"]);
    expect(git(receipt.workspace, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(receipt.workspace, "rev-parse", "HEAD")).toBe(commit);
    expect(git(receipt.workspace, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(`refs/remotes/origin/${branch}`);
    expect(git(receipt.workspace, "remote", "get-url", "origin")).toBe(draft.url);
    expect(git(receipt.workspace, "config", "--local", "--list")).not.toContain(token);
    expect(await readFile(join(receipt.workspace, "src", "fixture.ts"), "utf8")).toBe(code);

    const unsupported = await prepare({ ...draft, branch: unsupportedBranch });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.text()).toContain("submodules or symlinks");
    expect(await readdir(checkouts)).toEqual([basename(receipt.workspace)]);

    const projectList = await result<{ id: string }[]>(await request("coding/projects"));
    expect(projectList.map(({ id }) => id)).toEqual([registered.id]);
    const requestCount = seen.length;
    await writeFile(join(receipt.workspace, "src", "fixture.ts"), code + "// Keep this local edit.\n");
    await api.stop();
    api = undefined;
    api = await startRestoreApp(root, bundle, proxy.url);
    const reopened = await result<typeof receipt>(await prepare({ url: draft.url.replace(/\.git$/u, ""), branch, approved: true }));
    expect(reopened).toEqual({ ...receipt, reused: true });
    expect(seen).toHaveLength(requestCount);
    expect(await readFile(join(reopened.workspace, "src", "fixture.ts"), "utf8")).toContain("Keep this local edit.");
    const project = await result<{ id: string; workspace: string; scopes: string[] }>(await request("coding/projects", {
      ...baseProject, title: "Prepared repository", workspace: reopened.workspace, scopes: ["src"],
    }));
    expect(project).toMatchObject({ workspace: reopened.workspace, scopes: ["src"] });
    expect((await request(`coding/projects/${project.id}/preview`, { source: "files", files: ["src/fixture.ts"] })).status).toBe(200);
    expect(await result(await request(`coding/projects/${project.id}/runs`))).toEqual([]);
  } finally {
    fetchRelease.resolve();
    await api?.stop();
    await proxy?.stop();
    await tls?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
