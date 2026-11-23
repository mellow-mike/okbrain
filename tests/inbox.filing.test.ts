import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { parse, serialize } from "../src/core/okf/document.ts";
import { okb } from "./helpers.ts";

test("CLI filing preserves history and links after preview, confirmation, and retry", async () => {
  const parent = await mkdtemp(join(tmpdir(), "okb-inbox-file-"));
  const root = join(parent, "brain");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  const cli = (args: string[]) => okb(["--bundle", root, ...args]);
  try {
    const captured = await cli(["capture", "Garden map", "--json"]);
    expect(captured.code).toBe(0);
    const { id, path } = JSON.parse(captured.stdout) as { id: string; path: string };
    const original = parse(await readFile(path, "utf8"));
    original.body += '[Fern](../sources/fern.md?detail=1#care "See care")\n![Sketch](../images/sketch.png)\n';
    original.frontmatter = {
      ...original.frontmatter,
      tags: ["inbox", "gardening"],
      verified: [{ by: "human:reviewer", at: "2026-01-02T12:00:00Z" }],
      sources: [{ id: "fern", resource: "../sources/fern.md", custom: "keep" }],
      custom: { original: [1, false] },
    };
    const raw = serialize(original);
    await writeFile(path, raw);
    await mkdir(join(root, "sources"));
    await writeFile(join(root, "sources", "fern.md"), "---\ntype: reference\ntitle: Fern\n---\nCare.\n");
    const backlink = `[Capture](/${id}.md#garden)\n`;
    await writeFile(join(root, "backlink.md"), backlink);
    expect((await cli(["index"])).code).toBe(0);

    const dest = "projects/garden/map";
    const target = join(root, "projects", "garden", "map.md");
    const file = ["inbox", "file", id, dest, "--json"];
    const previewResponse = await cli(file);
    expect(previewResponse.code).toBe(0);
    const preview = JSON.parse(previewResponse.stdout).preview as string;
    expect(preview).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(target).exists()).toBe(false);
    expect(await readFile(path, "utf8")).toBe(raw);
    expect((await cli([...file, "--confirm", "invalid"])).stderr).toContain("Preview the filing again");
    await writeFile(path, raw + "Concurrent edit.\n");
    expect((await cli([...file, "--confirm", preview])).stderr).toContain("changed");
    expect(await Bun.file(target).exists()).toBe(false);
    await writeFile(path, raw);

    const alias = join(root, "alias");
    await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await cli(["inbox", "file", id, "alias/capture"])).stderr).toContain("ordinary folder inside this brain");
    expect((await cli(["inbox", "file", id, "db_only/draft"])).stderr).toContain("privacy scope");
    expect((await cli(["inbox", "file", id, "backlink"])).stderr).toContain("already exists");
    expect((await cli([...file, "--confirm", preview])).code).toBe(0);
    expect(await readFile(join(root, "backlink.md"), "utf8")).toBe(backlink);
    const saved = await readFile(target, "utf8");
    expect(parse(saved)).toMatchObject({
      frontmatter: {
        ...original.frontmatter, tags: ["gardening"], sources: [{ id: "fern", resource: "/sources/fern.md", custom: "keep" }],
        inbox_filing: { from: id, preview },
      },
      body: original.body.replaceAll("../sources/", "../../sources/").replaceAll("../images/", "../../images/"),
    });
    expect(parse(await readFile(path, "utf8")).frontmatter).toMatchObject({ type: "forwarding", filed_to: dest });
    expect((await cli(["inbox", "--json"])).stdout.trim()).toBe("[]");
    expect((await cli(["search", "Garden map", "--profile", "lean", "--json"])).stdout).toContain(dest);

    // An interruption after the destination was published leaves the exact original and one recoverable copy.
    await writeFile(path, raw);
    const resumed = await cli(file);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ preview, status: "resume" });
    expect((await cli([...file, "--confirm", preview])).code).toBe(0);
    expect(await readFile(target, "utf8")).toBe(saved);
    expect((await cli([...file, "--confirm", preview])).code).toBe(0);
    expect(await readFile(target, "utf8")).toBe(saved);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("local app filing stays in the existing privacy boundary and requires preview approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-inbox-app-"));
  const token = "inbox-file-test";
  const id = "db_only/inbox/private-capture";
  await mkdir(join(root, "db_only", "inbox"), { recursive: true });
  await writeFile(join(root, "db_only", "inbox", "private-capture.md"), "---\ntype: note\ntitle: Confidential\ndescription: Private draft\ntags: inbox\n---\nPrivate body.\n");
  const writable = createApiServer({ bundle: root, port: 0, token });
  const readonly = createApiServer({ bundle: root, port: 0, token, readonly: true });
  function call(url: string, destination: string, headers = { "x-okb-token": token }, confirm?: string) {
    return fetch(url + "api/op/inbox_file", {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ id, destination, confirm }),
    });
  }
  try {
    const destination = "db_only/notes/private-capture";
    expect((await call(readonly.url, destination)).status).toBe(403);
    expect((await call(writable.url, destination, { "x-okb-token": "wrong" })).status).toBe(401);
    expect((await call(writable.url, "notes/private-capture")).status).toBe(400);
    const response = await call(writable.url, destination);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { result } = await response.json() as { result: { preview: string } };
    expect(await Bun.file(join(root, "db_only", "notes", "private-capture.md")).exists()).toBe(false);
    expect((await call(writable.url, destination, undefined, result.preview)).status).toBe(200);
    expect(await readFile(join(root, "db_only", "notes", "private-capture.md"), "utf8")).toContain("Private body.");
    expect(await readFile(join(root, "index.md"), "utf8")).not.toContain("Confidential");
  } finally {
    writable.stop();
    readonly.stop();
    await rm(root, { recursive: true, force: true });
  }
});
