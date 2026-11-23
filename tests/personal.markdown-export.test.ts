import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { okb } from "./helpers.ts";

test("the CLI exports copied Markdown with relative links, exact YAML, and explicit private opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-export-cli-"));
  const bundle = join(root, "brain");
  const output = join(root, "new vault");
  const complete = join(root, "complete vault");
  const folder = join(bundle, "notes");
  const secretFolder = join(folder, "db_only");
  await mkdir(secretFolder, { recursive: true });
  const yaml = "\uFEFF---\r\n# Keep comment\r\ntype: note\r\nunknown: '[Yaml](/other.md)'\r\n---\r\n";
  const code = "```md\r\n[Example](/other.md)\r\n```\r\n";
  const body = '[Other](/other.md?draft=0#title "read")\r\n[Local](/notes/A%20note.md)\r\n' +
    '[External](https://example.test/other.md)\r\n[Missing](/missing.md)\r\n' + code;
  const privateBody = "Private text. [Other](/other.md)\n";
  try {
    await writeFile(join(folder, "start.md"), yaml + body);
    await writeFile(join(folder, "A note.md"), "---\nunknown: [unclosed\n---\n[Other](/other.md)\n");
    await writeFile(join(bundle, "other.md"), "Plain Markdown.\n");
    await writeFile(join(secretFolder, "private.md"), privateBody);
    await writeFile(join(secretFolder, "index.md"), "Private index.\n");
    await writeFile(join(bundle, "index.md"), "Index.\n");
    await writeFile(join(bundle, "log.md"), "Log.\n");
    await writeFile(join(bundle, "attachment.txt"), "Attachment.\n");

    const r = await okb(["--bundle", bundle, "export-markdown", output, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ notes: 3, includesPrivate: false });
    expect(await readFile(join(output, "notes", "start.md"), "utf8")).toBe(yaml + body
      .replace('(/other.md?draft=0#title "read")', '(../other.md?draft=0#title "read")')
      .replace("(/notes/A%20note.md)", "(A%20note.md)"));
    expect(await readFile(join(output, "notes", "A note.md"), "utf8")).toBe("---\nunknown: [unclosed\n---\n[Other](../other.md)\n");
    for (const name of ["index.md", "log.md", "attachment.txt", "notes/db_only/private.md"])
      expect(await Bun.file(join(output, name)).exists()).toBe(false);
    expect(await readFile(join(folder, "start.md"), "utf8")).toBe(yaml + body);

    expect((await okb(["--bundle", bundle, "export-markdown", complete, "--include-private"])).code).toBe(0);
    expect(await readFile(join(complete, "notes", "db_only", "private.md"), "utf8")).toBe(privateBody.replace("(/other.md)", "(../../other.md)"));
    expect((await okb(["--bundle", bundle, "export-markdown", output])).stderr).toContain("already exists");
    expect((await okb(["--bundle", bundle, "export-markdown", "relative/path"])).stderr).toContain("absolute local path");
    expect((await okb(["--bundle", bundle, "export-markdown", join(bundle, "inside")])).stderr).toContain("outside the current brain");

    const alias = join(root, "alias");
    await symlink(bundle, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await okb(["--bundle", bundle, "export-markdown", join(alias, "inside")])).stderr).toContain("outside the current brain");
    const large = join(bundle, "large.md");
    const failedOutput = join(root, "too-large");
    await writeFile(large, "");
    await truncate(large, 16 * 1024 * 1024 + 1);
    expect((await okb(["--bundle", bundle, "export-markdown", failedOutput])).stderr).toContain("16 MiB");
    await expect(lstat(failedOutput)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the app requires the local owner and a writable brain before exporting", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-export-app-"));
  const bundle = join(root, "brain");
  const destination = join(root, "vault");
  await mkdir(bundle);
  await writeFile(join(bundle, "note.md"), "Note.\n");
  const token = "markdown-export-local";
  const server = createApiServer({ bundle, port: 0, token });
  const readonly = createApiServer({ bundle, port: 0, token, readonly: true });
  function post(url: string, headers: Record<string, string>, body = JSON.stringify({ destination })) {
    return fetch(url + "api/op/export_markdown", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body,
    });
  }
  try {
    const authorized = { "x-okb-token": token };
    expect((await post(server.url, { authorization: "Bearer " + token })).status).toBe(401);
    expect((await post(server.url, { ...authorized, origin: "https://example.test" })).status).toBe(403);
    expect((await post(readonly.url, authorized)).status).toBe(403);
    expect((await post(server.url, authorized, " ".repeat(16 * 1024 + 1))).status).toBe(413);
    const [first, second] = await Promise.all([post(server.url, authorized), post(server.url, authorized)]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const made = first.ok ? first : second;
    expect(made.headers.get("cache-control")).toBe("no-store");
    expect(await made.json()).toMatchObject({ result: { notes: 1, includesPrivate: false } });
    expect(await readFile(join(destination, "note.md"), "utf8")).toBe("Note.\n");
  } finally {
    server.stop();
    readonly.stop();
    await rm(root, { force: true, recursive: true });
  }
});
