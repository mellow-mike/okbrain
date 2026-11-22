import { createHash } from "node:crypto";
import {
  approvedPatchFileBytes, approvedPatchFileLimit, isApprovedPatchPath, patchDigest,
  type ApprovedPatchFile, type PatchFileReceipt,
} from "./approved-patch.ts";
import { githubBranch, GitHubError, type GitHubFetch } from "./github.ts";

const apiOrigin = "https://api.github.com";
const maxResponseBytes = 4 * 1024 * 1024;
const maxGitDataBytes = 24 * 1024 * 1024;
const maxTrees = 128;
const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

type RecordValue = Record<string, unknown>;

export interface GitHubBranchBase {
  baseSha: string;
  baseTree: string;
}

type GitHubPatchCommit = GitHubBranchBase & { message: string; files: readonly ApprovedPatchFile[] };

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

function objectSha(value: unknown): string {
  if (typeof value !== "string" || !shaPattern.test(value))
    throw new GitHubError("GitHub returned an invalid Git object identifier.", 502);
  return value;
}

function fileMode(value: unknown): value is ApprovedPatchFile["mode"] {
  return value === "100644" || value === "100755";
}

function checkFiles(files: readonly PatchFileReceipt[]) {
  if (!files.length || files.length > approvedPatchFileLimit)
    throw new GitHubError("Choose an applied patch with up to eight edited files.");
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || !isApprovedPatchPath(file.path) || !fileMode(file.mode) || seen.has(file.path.toLowerCase()) ||
        !digestPattern.test(file.before) || !digestPattern.test(file.after) || file.before === file.after)
      throw new GitHubError("The applied patch has an invalid file receipt.", 409);
    seen.add(file.path.toLowerCase());
  }
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

async function responseData(response: Response, count: (size: number) => void): Promise<RecordValue> {
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) throw new Error();
        count(value.byteLength);
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return record(JSON.parse(Buffer.concat(chunks, total).toString("utf8")));
  } catch {
    throw new GitHubError("GitHub returned unreadable or oversized Git data.", 502);
  }
}

function gitDatabase(repository: string, token: string, transport: GitHubFetch) {
  const parts = /^([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})$/u.exec(repository);
  if (!parts || parts[2] === "." || parts[2] === "..") throw new GitHubError("Choose a bound GitHub repository.");
  const base = `/repos/${repository}/git`;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "okbrain",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
  const signal = AbortSignal.timeout(25_000);
  let readBytes = 0;
  const count = (size: number) => {
    readBytes += size;
    if (readBytes > maxGitDataBytes) throw new Error();
  };

  async function request(path: string, body?: RecordValue, allowMissing = false): Promise<RecordValue | null> {
    let response: Response;
    try {
      response = await transport(new URL(base + path, apiOrigin), {
        method: body ? "POST" : "GET", redirect: "error", signal,
        headers: body ? { ...headers, "content-type": "application/json" } : headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new GitHubError(body
        ? "GitHub did not confirm the write. Check the branch before retrying."
        : "GitHub could not be reached to inspect the branch.", 502);
    }
    if (response.status === (body ? 201 : 200)) return responseData(response, count);
    void response.body?.cancel().catch(() => {});
    if (!body && allowMissing && response.status === 404) return null;
    if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0"))
      throw new GitHubError("GitHub's rate limit was reached. Try again later.", 502);
    if (response.status === 401 || response.status === 403 || response.status === 404)
      throw new GitHubError("Check that the branch token has access to this repository and Contents write permission.", 502);
    if (body && (response.status === 409 || response.status === 422))
      throw new GitHubError("GitHub rejected the branch write. Check the branch name and repository rules.", 409);
    throw new GitHubError(body
      ? "GitHub did not confirm the write. Check the branch before retrying."
      : "GitHub did not return the requested Git data.", 502);
  }

  return {
    get: async (path: string) => (await request(path))!,
    getRef: (branch: string) => request(`/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, undefined, true),
    post: async (path: string, body: RecordValue) => (await request(path, body))!,
  };
}

function refSha(ref: RecordValue, branch: string): string {
  const target = record(ref.object);
  if (ref.ref !== `refs/heads/${branch}` || target.type !== "commit")
    throw new GitHubError("GitHub returned a different branch reference.", 502);
  return objectSha(target.sha);
}

/** Read an exact head ref. Use the singular endpoint so a branch prefix cannot match. */
export async function githubBranchRef(repository: string, name: string, token: string, transport: GitHubFetch): Promise<string | null> {
  const branch = githubBranch(name);
  const ref = await gitDatabase(repository, token, transport).getRef(branch);
  return ref ? refSha(ref, branch) : null;
}

type Database = ReturnType<typeof gitDatabase>;

function treeEntries(data: RecordValue, sha: string): RecordValue[] {
  if (data.sha !== sha || data.truncated !== false || !Array.isArray(data.tree))
    throw new GitHubError("GitHub returned a different or incomplete Git tree.", 502);
  return data.tree.map(record);
}

/** Walk only the trees containing selected files, caching shared directories. */
function treePaths(db: Database, rootSha: string) {
  const cache = new Map<string, Promise<RecordValue[]>>();

  function getTree(sha: string) {
    const prior = cache.get(sha);
    if (prior) return prior;
    if (cache.size >= maxTrees)
      throw new GitHubError("The approved paths span too many GitHub directories for one branch.", 409);
    const loaded = db.get(`/trees/${sha}`).then((tree) => treeEntries(tree, sha));
    cache.set(sha, loaded);
    return loaded;
  }

  return async (file: PatchFileReceipt) => {
    const parts = file.path.split("/");
    const leafName = parts.pop()!;
    let sha = rootSha;
    for (const part of parts) {
      const nodes = (await getTree(sha)).filter((node) => node.path === part);
      const directory = nodes[0];
      if (nodes.length !== 1 || directory?.type !== "tree" || directory.mode !== "040000")
        throw new GitHubError(`GitHub’s tree does not match the approved path ${file.path}.`, 409);
      sha = objectSha(directory.sha);
    }
    const nodes = (await getTree(sha)).filter((node) => node.path === leafName);
    const entry = nodes[0];
    if (nodes.length !== 1 || entry?.type !== "blob" || entry.mode !== file.mode)
      throw new GitHubError(`GitHub’s file or mode does not match the approved path ${file.path}.`, 409);
    return objectSha(entry.sha);
  };
}

function readBlob(data: RecordValue, sha: string): Buffer {
  if (data.sha !== sha || data.encoding !== "base64" || typeof data.content !== "string" ||
      typeof data.size !== "number" || !Number.isInteger(data.size) || data.size < 0 || data.size > approvedPatchFileBytes)
    throw new GitHubError("GitHub returned an invalid or oversized file blob.", 502);
  const encoded = data.content.replace(/[\r\n]/gu, "");
  if (encoded.length !== Math.ceil(data.size / 3) * 4)
    throw new GitHubError("GitHub returned bytes that do not match the file blob.", 502);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== data.size || bytes.toString("base64") !== encoded || gitBlobSha(bytes) !== sha)
    throw new GitHubError("GitHub returned bytes that do not match the file blob.", 502);
  return bytes;
}

/** Bind the approved existing-file edits to an immutable GitHub parent and tree. */
export async function githubPreparePatchBranch(
  repository: string, name: string, files: readonly PatchFileReceipt[], token: string, transport: GitHubFetch,
): Promise<GitHubBranchBase> {
  checkFiles(files);
  const branch = githubBranch(name);
  const db = gitDatabase(repository, token, transport);
  const ref = await db.getRef(branch);
  if (!ref) throw new GitHubError("Choose an existing base branch in this GitHub repository.", 409);
  const baseSha = refSha(ref, branch);
  const commit = await db.get(`/commits/${baseSha}`);
  if (commit.sha !== baseSha) throw new GitHubError("GitHub returned a different base commit.", 502);
  const baseTree = objectSha(record(commit.tree).sha);
  const leaf = treePaths(db, baseTree);
  await Promise.all(files.map(async (file) => {
    const sha = await leaf(file);
    const bytes = readBlob(await db.get(`/blobs/${sha}`), sha);
    if (patchDigest(bytes) !== file.before)
      throw new GitHubError(`The GitHub base differs from the approved starting bytes of ${file.path}.`, 409);
  }));
  return { baseSha, baseTree };
}

/** Upload reviewed bytes and commit them to the pinned base. No branch is mutated here. */
export async function githubCreatePatchCommit(
  repository: string, input: GitHubPatchCommit, token: string, transport: GitHubFetch,
): Promise<string> {
  const baseSha = objectSha(input.baseSha);
  const baseTree = objectSha(input.baseTree);
  const message = input.message;
  if (typeof message !== "string" || !message.trim() || message.includes("\0") || Buffer.byteLength(message) > 16 * 1024)
    throw new GitHubError("Enter a commit message up to 16 KiB.");
  checkFiles(input.files);
  const files = input.files.map((file) => {
    // Copy and validate the whole captured snapshot before the first outbound write.
    const bytes = Buffer.from(file.bytes);
    if (bytes.byteLength > approvedPatchFileBytes || patchDigest(bytes) !== file.after)
      throw new GitHubError(`The captured bytes of ${file.path} differ from the applied patch.`, 409);
    return { file, sha: gitBlobSha(bytes), content: bytes.toString("base64") };
  });
  const db = gitDatabase(repository, token, transport);
  await Promise.all(files.map(async ({ sha, content }) => {
    const blob = await db.post("/blobs", { content, encoding: "base64" });
    if (blob.sha !== sha) throw new GitHubError("GitHub returned a different uploaded blob.", 502);
  }));
  const tree = await db.post("/trees", {
    base_tree: baseTree,
    tree: files.map(({ file, sha }) => ({ path: file.path, mode: file.mode, type: "blob", sha })),
  });
  const treeSha = objectSha(tree.sha);
  // The write response can contain a truncated listing. Read the addressed
  // tree with the nonrecursive GET endpoint before committing.
  const leaf = treePaths(db, treeSha);
  await Promise.all(files.map(async ({ file, sha }) => {
    if (await leaf(file) !== sha) throw new GitHubError("GitHub returned a tree with different file changes.", 502);
  }));
  const commit = await db.post("/commits", { message, tree: treeSha, parents: [baseSha] });
  if (commit.message !== message || record(commit.tree).sha !== treeSha ||
      !Array.isArray(commit.parents) || commit.parents.length !== 1 || record(commit.parents[0]).sha !== baseSha)
    throw new GitHubError("GitHub returned a commit that differs from the approved branch.", 502);
  return objectSha(commit.sha);
}

/** Create a new GitHub branch. The create-only API refuses an existing ref. */
export async function githubCreatePatchRef(
  repository: string, name: string, commit: string, token: string, transport: GitHubFetch,
): Promise<void> {
  const branch = githubBranch(name);
  const sha = objectSha(commit);
  const ref = await gitDatabase(repository, token, transport).post("/refs", { ref: `refs/heads/${branch}`, sha });
  if (refSha(ref, branch) !== sha) throw new GitHubError("GitHub returned a branch at a different commit.", 502);
}
