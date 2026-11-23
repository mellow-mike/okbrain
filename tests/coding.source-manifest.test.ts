// The source manifest names what a Coding preview selected without the
// selected text. The apps and editor copy it before a send; the CLI prints
// the same repository manifest from `okb code context --json`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { previewCodingAttachments } from "../src/core/coding/durable.ts";
import { previewPackageReviews } from "../src/core/coding/package-review.ts";
import { selectRepositoryContext, type RepositoryContextExcerpt, type RepositoryContextManifest } from "../src/core/coding/repository-context.ts";
import type { CodingRunReport } from "../src/core/coding/run-report.ts";
import { codingSourceManifest, type CodingSourceManifest } from "../src/core/coding/source-manifest.ts";
import { okb } from "./helpers.ts";

const ownerToken = "source-manifest-owner";
const sourceText = ["web source marker", "auth source marker", "Résumé source marker", "Guidance marker for the model."];
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const withoutSourceText = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const text of sourceText) expect(json).not.toContain(text);
  for (const key of ["content", "excerpts", "guidance", "text"]) expect(json).not.toContain(`"${key}"`);
};

let root: string;
let workspace: string;

beforeAll(async () => {
  // The attachment preview takes a canonical workspace, and a temporary directory can be a symlink.
  root = await realpath(await mkdtemp(join(tmpdir(), "okb-source-manifest-")));
  workspace = join(root, "work");
  await mkdir(join(workspace, "apps", "web"), { recursive: true });
  await mkdir(join(workspace, "packages", "auth"), { recursive: true });
  await writeFile(join(workspace, "apps", "web", "session.ts"),
    "import { tokenTtl } from '../../packages/auth/token';\nexport function refreshSession() {\n  return 'web source marker' + tokenTtl;\n}\n");
  await writeFile(join(workspace, "packages", "auth", "token.ts"), "export const tokenTtl = 'auth source marker';\n");
  await writeFile(join(workspace, "README.md"), "# Résumé source marker\n");
  for (const args of [["init", "--quiet"], ["add", "--", "."],
    ["-c", "user.name=Manifest Test", "-c", "user.email=manifest@example.test", "commit", "--quiet", "-m", "Fixture"]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: workspace, env: { ...process.env }, stdout: "ignore", stderr: "pipe" });
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  }
});

afterAll(() => rm(root, { recursive: true, force: true }));

test("a repository manifest is the CLI's manifest for the same preview and carries what its ID binds", async () => {
  const options = { projects: ["apps/web", "packages/auth"], query: "refreshSession tokenTtl", tokenBudget: 2500 };
  const selection = await selectRepositoryContext({ workspace, ...options });
  expect(selection.excerpts.map(({ path }) => path).sort()).toEqual(["apps/web/session.ts", "packages/auth/token.ts"]);
  const copied = codingSourceManifest({ source: "repository", ...selection });
  expect(copied).toEqual({ version: 1, source: "repository", id: selection.manifest.id, manifest: selection.manifest });
  withoutSourceText(copied);
  if (copied.source !== "repository") throw new Error("Expected a repository manifest.");
  const { projects, query, tokenBudget, files } = copied.manifest;
  expect(sha256(JSON.stringify([1, projects, query, tokenBudget, files]))).toBe(copied.id);
  expect(files.map(({ sha256: digest }) => digest)).toEqual(selection.excerpts.map(({ content }) => sha256(content)));

  const cli = await okb(["code", "context", "--workspace", workspace, "--projects", options.projects.join(","),
    "--query", options.query, "--context-tokens", String(options.tokenBudget), "--json"]);
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual({ manifest: copied.manifest });

  // A profile adds its receipt, revision, and index counts. Its guidance stays with the preview.
  const profile = { version: 1 as const, name: "Web", projects: ["apps/web"], sharedProjects: ["packages/auth"],
    exclude: ["apps/web/generated"], guidance: "Guidance marker for the model.", tokenBudget: 2500 };
  const profiled = await selectRepositoryContext({ workspace, profile, query: "refreshSession" });
  expect(profiled.guidance).toBe(profile.guidance);
  const withProfile = codingSourceManifest({ source: "repository", ...profiled });
  expect(withProfile).toEqual({ version: 1, source: "repository", id: profiled.manifest.id, manifest: profiled.manifest });
  expect(profiled.manifest).toMatchObject({
    profile: { version: 1, name: "Web", id: expect.stringMatching(/^[0-9a-f]{64}$/), sharedProjects: ["packages/auth"], exclude: ["apps/web/generated"] },
    workspaceRevision: expect.stringMatching(/^[0-9a-f]{40}$/), index: { indexedFiles: expect.any(Number), limited: false },
  });
  withoutSourceText(withProfile);

  // Only the manifest's own fields are copied, even if a preview object carries more.
  const widened = { ...selection.manifest, excerpts: selection.excerpts, guidance: profile.guidance,
    files: selection.manifest.files.map((file, index) => ({ ...file, content: selection.excerpts[index]!.content })) };
  expect(codingSourceManifest({ source: "repository", manifest: widened })).toEqual(copied);
});

test("explicit files are listed by path, size, and digest of the previewed bytes", async () => {
  const preview = await previewCodingAttachments(workspace, ["apps/web/session.ts", "README.md"]);
  const copied = codingSourceManifest({ source: "files", ...preview });
  const session = await readFile(join(workspace, "apps", "web", "session.ts"));
  const readme = await readFile(join(workspace, "README.md"));
  expect(copied).toEqual({ version: 1, source: "files", id: preview.id, files: [
    { path: "apps/web/session.ts", bytes: session.byteLength, sha256: sha256(session) },
    { path: "README.md", bytes: readme.byteLength, sha256: sha256(readme) },
  ] });
  expect(readme.byteLength).toBeGreaterThan(readme.toString("utf8").length);
  withoutSourceText(copied);
  expect(JSON.stringify(copied)).not.toContain(workspace);
});

test("independent package reviews list each package's manifest under the shared preview ID", async () => {
  const preview = await previewPackageReviews(workspace, [
    { project: "apps/web", query: "refreshSession" }, { project: "packages/auth", query: "tokenTtl" },
  ]);
  const copied = codingSourceManifest({ source: "packages", ...preview });
  expect(copied).toEqual({ version: 1, source: "packages", id: preview.id,
    packages: preview.packages.map(({ project, manifest }) => ({ project, manifest })) });
  if (copied.source !== "packages") throw new Error("Expected a package manifest.");
  expect(copied.packages.map(({ project, manifest }) => [project, manifest.files.length])).toEqual([["apps/web", 1], ["packages/auth", 1]]);
  expect(sha256(JSON.stringify([1, copied.packages.map(({ manifest }) => manifest.id)]))).toBe(copied.id);
  withoutSourceText(copied);
});

test("every app preview carries the manifest, previews call no provider, and the manifest ID is the one a send approves", async () => {
  const stateDir = join(root, "state");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "manifest-test" }] });
  models.setProvider(faux.provider);
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken,
    coding: { stateDir: join(stateDir, "projects"), models }, standaloneCoding: { stateDir: join(stateDir, "standalone"), models } });
  async function call<T>(path: string, data?: unknown, token = ownerToken): Promise<T> {
    const response = await fetch(new URL("api/coding" + path, api.url), {
      method: data === undefined ? "GET" : "POST",
      headers: { ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(token === ownerToken ? { "x-okb-token": token } : { authorization: `Bearer ${token}` }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json() as { error?: string; result: T };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body.result;
  }
  type RepositoryPreview = { source: "repository"; id?: string; manifest: RepositoryContextManifest; excerpts: RepositoryContextExcerpt[];
    guidance?: string; sourceManifest: CodingSourceManifest };
  type FilesPreview = { source: "files"; id: string; files: { path: string; content: string }[]; sourceManifest: CodingSourceManifest };
  type PackagesPreview = { source: "packages"; id: string; packages: { project: string; manifest: RepositoryContextManifest }[];
    sourceManifest: CodingSourceManifest };
  try {
    const project = await call<{ id: string }>("/projects", {
      workspace, title: "Manifest project", scopes: ["apps/web", "packages/auth"], provider: "openai", model: "manifest-test", apiKey: "manifest-fixture-key",
    });
    const path = "/projects/" + project.id;
    const member = await call<{ token: string }>(path + "/members", { name: "manifest-reviewer" });
    const repository = { source: "repository", query: "refreshSession", projects: ["apps/web"] };
    const files = { source: "files", files: ["packages/auth/token.ts"] };
    const packages = { source: "packages", packages: [{ project: "apps/web", query: "refreshSession" }, { project: "packages/auth", query: "tokenTtl" }] };

    const ownerPreview = await call<RepositoryPreview>(path + "/preview", repository);
    expect(ownerPreview.excerpts[0]!.content).toContain("web source marker");
    expect(ownerPreview.sourceManifest).toEqual({ version: 1, source: "repository", id: ownerPreview.manifest.id, manifest: ownerPreview.manifest });
    withoutSourceText(ownerPreview.sourceManifest);
    expect((await call<RepositoryPreview>(path + "/preview", repository, member.token)).sourceManifest).toEqual(ownerPreview.sourceManifest);

    const filePreview = await call<FilesPreview>(path + "/preview", files, member.token);
    expect(filePreview.files[0]!.content).toContain("auth source marker");
    expect(filePreview.sourceManifest).toEqual({ version: 1, source: "files", id: filePreview.id,
      files: [{ path: "packages/auth/token.ts", bytes: Buffer.byteLength(filePreview.files[0]!.content), sha256: sha256(filePreview.files[0]!.content) }] });
    const packagePreview = await call<PackagesPreview>(path + "/preview", packages);
    expect(packagePreview.sourceManifest).toEqual({ version: 1, source: "packages", id: packagePreview.id,
      packages: packagePreview.packages.map(({ project: name, manifest }) => ({ project: name, manifest })) });

    const standaloneFiles = await call<FilesPreview>("/standalone/preview", { workspace, source: "files", files: ["README.md"] });
    expect(standaloneFiles.sourceManifest).toMatchObject({ version: 1, source: "files", id: standaloneFiles.id, files: [{ path: "README.md" }] });
    const guided = { workspace, source: "repository", query: "refreshSession",
      profile: { version: 1, name: "Web", projects: ["apps/web"], guidance: "Guidance marker for the model." } };
    const standaloneRepository = await call<RepositoryPreview>("/standalone/preview", guided);
    expect(standaloneRepository.guidance).toBe("Guidance marker for the model.");
    expect(standaloneRepository.sourceManifest).toEqual({ version: 1, source: "repository", id: standaloneRepository.id!, manifest: standaloneRepository.manifest });
    for (const preview of [filePreview, packagePreview, standaloneFiles, standaloneRepository]) withoutSourceText(preview.sourceManifest);

    // Six previews and their manifests reached no provider.
    expect(faux.state.callCount).toBe(0);

    // The copied ID is exactly the approval a send must repeat, and the saved run reports the same selection.
    faux.setResponses([fauxAssistantMessage("Manifest review.")]);
    const identity = { session: "manifest", requestId: "manifest-request" };
    await call(path + "/run", { ...repository, ...identity, prompt: "Review the session refresh.", approved: true, previewId: ownerPreview.sourceManifest.id });
    type Inspection = { run: { status: string }; report?: CodingRunReport };
    let inspection = await call<Inspection>(path + "/inspect", identity);
    for (const deadline = Date.now() + 4000; inspection.run.status === "running" && Date.now() < deadline;) {
      await Bun.sleep(20);
      inspection = await call<Inspection>(path + "/inspect", identity);
    }
    expect(inspection.run.status).toBe("done");
    expect(faux.state.callCount).toBe(1);
    expect(inspection.report?.request.repositoryContext).toMatchObject({ id: ownerPreview.sourceManifest.id,
      files: ownerPreview.manifest.files.map(({ path: file, startLine, endLine, sha256: digest }) => ({ path: file, startLine, endLine, sha256: digest })) });
  } finally { await api.stop(); }
});
