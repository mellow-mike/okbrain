/** GitHub requests are repository-scoped reads. Publication happens in GitHub's UI. */

export interface GitHubRemote {
  remote: string;
  repository: string;
}

export type GitHubFetch = (url: URL, options: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const GITHUB_ORIGIN = "https://github.com";
const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 30;

function githubRepository(remoteUrl: string): string | undefined {
  const scp = /^git@github\.com:([^\s]+)$/iu.exec(remoteUrl);
  let path = scp?.[1];
  if (!path) {
    const parsed = URL.parse(remoteUrl);
    if (!parsed || parsed.hostname !== "github.com" || parsed.search || parsed.hash || parsed.port || parsed.password)
      return;
    if (!((parsed.protocol === "https:" && !parsed.username) || (parsed.protocol === "ssh:" && parsed.username === "git")))
      return;
    path = parsed.pathname.slice(1);
  }
  const [owner, name, extra] = path.replace(/\.git$/i, "").split("/");
  if (extra !== undefined || !owner || !name ||
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu.test(owner) ||
      !/^[a-z0-9_.-]{1,100}$/iu.test(name) || name === "." || name === "..") return;
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** Inspect local Git configuration without contacting a remote or using its credentials. */
export async function githubRemotes(workspace: string): Promise<GitHubRemote[]> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  let command;
  try {
    command = Bun.spawn(["git", "config", "--local", "--null", "--get-regexp", "^remote\\..*\\.url$"], {
      cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
  } catch {
    throw new GitHubError("Git is required to detect project remotes.", 409);
  }
  const timer = setTimeout(() => command.kill(), 5000);
  let rows: string;
  try {
    const [status, output] = await Promise.all([command.exited, command.stdout.text()]);
    if (status === 1 || status === 128) return [];
    if (status !== 0) throw new GitHubError("Unable to inspect Git remotes in this workspace.", 409);
    rows = output;
  } finally {
    clearTimeout(timer);
  }
  const configured = new Map<string, string[]>();
  for (const row of rows.split("\0")) {
    const parsed = /^remote\.([a-zA-Z0-9][a-zA-Z0-9._/-]{0,127})\.url\n(.+)$/u.exec(row);
    if (!parsed) continue;
    const [, remote, url] = parsed;
    const existing = configured.get(remote!) ?? [];
    existing.push(url!);
    configured.set(remote!, existing);
  }
  return [...configured].flatMap(([remote, urls]) => {
    const repositories = [...new Set(urls.map(githubRepository))];
    if (repositories.length !== 1 || !repositories[0]) return [];
    return [{ remote, repository: repositories[0] }];
  }).sort((a, b) => a.remote.localeCompare(b.remote));
}

export function githubToken(value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^github_pat_[a-zA-Z0-9_]{20,256}$/.test(value.trim()))
    throw new GitHubError("Enter a GitHub fine-grained personal access token.");
  return value.trim();
}

export function githubUrl(repository: string) {
  return `${GITHUB_ORIGIN}/${repository}`;
}

function githubBranch(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9._/-]{0,254}$/.test(value) ||
      value.includes("..") || value.endsWith(".") ||
      value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new GitHubError("Enter valid branch names from this GitHub repository.");
  }
  return value;
}

export function githubComparison(repository: string, rawBase: unknown, rawHead: unknown): string {
  const base = githubBranch(rawBase);
  const head = githubBranch(rawHead);
  if (base === head) throw new GitHubError("Choose different base and head branches.");
  return `${githubUrl(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

interface GitHubItem {
  number: number;
  title: string;
  url: string;
  draft?: boolean;
  updatedAt?: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function getGitHub(path: string, token: string | null, transport: GitHubFetch): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "okbrain",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await transport(new URL(path, API_ORIGIN), {
      method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new GitHubError("GitHub could not be reached. Try refreshing again.", 502);
  }
  if (response.status === 401) throw new GitHubError("GitHub rejected the saved access token.", 502);
  if (response.status === 404) throw new GitHubError("GitHub could not find this repository. For a private repository, check the token's repository and permissions.", 502);
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0"))
    throw new GitHubError("GitHub's rate limit was reached. Try again later.", 502);
  if (response.status === 403) throw new GitHubError("GitHub denied access. Check the token's repository and read permissions.", 502);
  if (!response.ok) throw new GitHubError("GitHub could not load this repository's activity.", 502);
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
        if (total > 4 * 1024 * 1024) {
          await reader.cancel().catch(() => {});
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new GitHubError("GitHub returned unreadable or oversized data.", 502);
  }
}

function activities(repository: string, value: unknown, kind: "issues" | "pull"): GitHubItem[] {
  if (!Array.isArray(value)) throw new GitHubError("GitHub returned unexpected activity data.", 502);
  return value.slice(0, PAGE_SIZE).flatMap((item) => {
    const row = asRecord(item);
    if ((kind === "issues" && row.pull_request) || typeof row.number !== "number" ||
        !Number.isSafeInteger(row.number) || row.number < 1 || typeof row.title !== "string") return [];
    return [{
      number: row.number,
      title: row.title.slice(0, 256),
      url: `${githubUrl(repository)}/${kind}/${row.number}`,
      ...(kind === "pull" ? { draft: row.draft === true } : {}),
      ...(typeof row.updated_at === "string" && /^[\dT:.+Z-]{1,32}$/.test(row.updated_at) ? { updatedAt: row.updated_at } : {}),
    }];
  });
}

export async function githubActivity(repository: string, token: string | null, transport: GitHubFetch) {
  const base = `/repos/${repository}`;
  const repo = asRecord(await getGitHub(base, token, transport));
  if (typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== repository || typeof repo.default_branch !== "string")
    throw new GitHubError("GitHub returned a different repository. Detect and reconnect the project remote.", 409);
  const query = `?state=open&per_page=${PAGE_SIZE}&sort=updated&direction=desc`;
  const [issues, pulls] = await Promise.all([
    repo.has_issues === false ? [] : getGitHub(`${base}/issues${query}`, token, transport),
    getGitHub(`${base}/pulls${query}`, token, transport),
  ]);
  return {
    repository,
    url: githubUrl(repository),
    defaultBranch: repo.default_branch,
    issuesEnabled: repo.has_issues !== false,
    issues: activities(repository, issues, "issues"),
    pulls: activities(repository, pulls, "pull"),
  };
}
