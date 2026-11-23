import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import type { SourceUploadResult } from "../src/core/ingest/personal-sources.ts";
import { okb } from "./helpers.ts";

const TOKEN = "personal-source-test";
let root: string;
let server: ApiServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-source-"));
  server = createApiServer({ bundle: root, port: 0, token: TOKEN });
});

afterEach(async () => {
  server.stop();
  await rm(root, { recursive: true, force: true });
});

function post(op: string, input: unknown) {
  return fetch(server.url + "api/op/" + op, {
    method: "POST",
    headers: { "x-okb-token": TOKEN },
    body: JSON.stringify(input),
  });
}

function upload(
  kind: string,
  files: [path: string, body: string][],
  confirmation?: { preview: string; selected: number[] },
  target: ApiServer = server,
  authorized = true,
) {
  const form = new FormData();
  form.set("name", "My archive");
  form.set("paths", JSON.stringify(files.map(([path]) => path)));
  files.forEach(([path, body]) => form.append("files", new File([body], path.split("/").at(-1)!)));
  if (confirmation) form.set("selected", JSON.stringify(confirmation.selected));
  return fetch(target.url + "api/personal/sources/upload?kind=" + kind, {
    method: "POST",
    headers: { ...(authorized ? { "x-okb-token": TOKEN } : {}), ...(confirmation ? { "x-okb-preview": confirmation.preview } : {}) },
    body: form,
  });
}

async function receipt(response: Response): Promise<SourceUploadResult> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return ((await response.json()) as { result: SourceUploadResult }).result;
}

const mail = [
  "From: Field Guide <guide@example.invalid>",
  "Message-ID: <field-note@example.invalid>",
  "Subject: =?UTF-8?Q?Jard=C3=ADn_field_note?=",
  "Date: Sun, 22 Nov 2026 16:00:00 +0000",
  "Content-Type: multipart/mixed; boundary=sample",
  "", "--sample", "Content-Type: text/plain; charset=windows-1252", "Content-Transfer-Encoding: quoted-printable", "",
  "Caf=E9 with the botanist", "~~~", "![Image](https://example.invalid/pixel)",
  "--sample", "Content-Type: text/plain", 'Content-Disposition: attachment; filename="attachment.txt"', "", "Attachment secret",
  "--sample", "Content-Type: message/rfc822", "", "Subject: Forwarded attachment", "", "Nested private text",
  "--sample--", "",
].join("\r\n");

test("email preview decodes MIME, discards attachments, and reconciles a renamed message", async () => {
  const files: [string, string][] = [["note.eml", mail], ["damaged.eml", "unrecognized file"]];
  const preview = await receipt(await upload("email", files));
  expect(preview.rows).toMatchObject([
    { row: 1, title: "Jardín field note", status: "new", excerpt: expect.stringContaining("Café with the botanist") },
    { row: 2, status: "skipped" },
  ]);
  const id = preview.rows[0]!.id!;
  expect((await post("read_concept", { id })).status).toBe(404);
  const confirmed = await receipt(await upload("email", files, { preview: preview.preview, selected: [1] }));
  expect(confirmed.imported).toEqual([id]);
  const saved = await Bun.file(join(root, `${id}.md`)).text();
  expect(saved).toContain("~~~~text\nFrom: Field Guide");
  expect(saved).toContain("Café with the botanist\n~~~\n![Image]");
  expect(saved).not.toContain("Attachment secret");
  expect(saved).not.toContain("Nested private text");
  expect((await receipt(await upload("email", [["renamed.eml", mail]]))).rows[0]).toMatchObject({ id, status: "unchanged" });
  expect((await upload("email", [["oversized.eml", "a".repeat(2 * 1024 * 1024 + 1)]])).status).toBe(413);
  const history = await fetch(server.url + "api/personal/sources/history", { headers: { "x-okb-token": TOKEN } });
  expect(await history.json()).toMatchObject({ result: [{ kind: "email", notes: [{ id, title: "Jardín field note" }] }] });
});

const calendar = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Schedule//EN",
  "BEGIN:VEVENT", "UID:weekly-study@example.invalid", "DTSTAMP:20261118T000000Z",
  "SUMMARY:Study group", "DTSTART;TZID=America/Los_Angeles:20261122T173000", "RRULE:FREQ=WEEKLY;COUNT=99999",
  "DESCRIPTION:Review the notes\\, including the field\r\n  map.", "ATTACH:https://example.invalid/private.pdf",
  "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Private alarm", "TRIGGER:-PT5M", "END:VALARM", "END:VEVENT",
  "BEGIN:VEVENT", "UID:weekly-study@example.invalid", "DTSTAMP:20261118T000000Z",
  "SUMMARY:Study group moved", "RECURRENCE-ID;TZID=America/Los_Angeles:20261129T173000", "DTSTART;VALUE=DATE:20261130",
  "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

test("calendar previews a recurring series and explicit exception, and CLI imports only confirmed rows", async () => {
  const file = join(root, "schedule.ics");
  await writeFile(file, calendar);
  const args = ["--bundle", root, "source", "import", file, "--kind", "calendar", "--name", "Study", "--json"];
  let cli = await okb(args);
  expect(cli.code).toBe(0);
  const preview = JSON.parse(cli.stdout) as SourceUploadResult;
  expect(preview.rows).toMatchObject([
    { row: 1, title: "Study group", excerpt: "Review the notes, including the field map.", status: "new" },
    { row: 2, title: "Study group moved", status: "new" },
  ]);
  const id = preview.rows[1]!.id!;
  expect((await post("read_concept", { id })).status).toBe(404);
  await writeFile(file, calendar.replace("Study group moved", "Different selection"));
  expect((await okb([...args, "--preview", preview.preview, "--selected", "2"])).code).toBe(2);
  await writeFile(file, calendar);
  cli = await okb([...args, "--preview", preview.preview, "--selected", "2"]);
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.stdout).imported).toEqual([id]);
  const saved = await Bun.file(join(root, `${id}.md`)).text();
  expect(saved).toContain("Starts: 2026-11-30");
  expect(saved).toContain("Recurrence exception: 2026-11-29T17:30:00 (America/Los_Angeles)");

  const files: [string, string][] = [["schedule.ics", calendar]];
  const apiPreview = await receipt(await upload("calendar", files));
  const apiResult = await receipt(await upload("calendar", files, { preview: apiPreview.preview, selected: [1] }));
  const series = await Bun.file(join(root, `${apiResult.imported[0]}.md`)).text();
  expect(series).toContain("Recurrence rule: FREQ=WEEKLY;COUNT=99999");
  expect(series).not.toContain("private.pdf");
  expect(series).not.toContain("Private alarm");
  expect((await receipt(await upload("calendar", [["renamed.ics", calendar.replace("COUNT=99999", "COUNT=2")]]))).rows[0])
    .toMatchObject({ previous: apiResult.imported[0], status: "changed" });
});

test("selected Markdown drafts retain provenance and links, and updates preserve local edits", async () => {
  expect((await post("index", {})).status).toBe(200);
  const files: [string, string][] = [
    ["First.md", "---\ncustom_hint: retained\ngenerated: { by: 'human:original' }\n---\n# First\n\nOriginal source draft.\n[Second](<Sub Folder/Second Note.md#why>)\n"],
    ["Sub Folder/Second Note.md", "# Second\n\nCompanion note.\n"],
    ["Omit.md", "# Unselected note\n"],
    ["attachment.png", "image content"],
  ];
  const preview = await receipt(await upload("markdown", files));
  expect(preview.rows.map((row) => row.status)).toEqual(["new", "new", "new", "skipped"]);
  const first = preview.rows[0]!.id!;
  const second = preview.rows[1]!.id!;
  const omitted = preview.rows[2]!.id!;
  expect((await post("read_concept", { id: first })).status).toBe(404);
  expect((await upload("notion", files, { preview: preview.preview, selected: [1] })).status).toBe(400);
  expect((await upload("markdown", files, { preview: preview.preview, selected: [4] })).status).toBe(400);

  const confirmed = await receipt(await upload("markdown", files, { preview: preview.preview, selected: [1, 2] }));
  expect(confirmed.imported).toEqual([first, second]);
  expect((await post("read_concept", { id: omitted })).status).toBe(404);
  expect(await (await post("read_concept", { id: first })).json()).toMatchObject({
    result: {
      body: expect.stringContaining(`[Second](/${second}.md#why)`),
      frontmatter: {
        status: "draft",
        custom_hint: "retained",
        original_generated: { by: "human:original" },
        sources: [{ id: "export", resource: "file-export:markdown", path: "First.md" }],
      },
    },
  });
  expect(await (await post("search", { query: "Companion note", profile: "lean" })).json()).toMatchObject({
    result: [expect.objectContaining({ id: second })],
  });
  expect(await Bun.file(join(root, "index.md")).text()).not.toContain("My archive");
  expect((await post("export_viz", {})).status).toBe(200);
  expect(await Bun.file(join(root, "viz.html")).text()).not.toContain("Companion note");

  expect((await post("write_concept", { id: first, body: "Local edited content." })).status).toBe(200);
  const repeated = await receipt(await upload("markdown", files));
  expect(repeated.rows.map((row) => row.status)).toEqual(["unchanged", "unchanged", "new", "skipped"]);
  const changed: [string, string][] = [["First.md", "# First updated\n\nFresh source version.\n"]];
  const update = await receipt(await upload("markdown", changed));
  expect(update.rows[0]).toMatchObject({ status: "changed", previous: first });
  const after = await receipt(await upload("markdown", changed, { preview: update.preview, selected: [1] }));
  expect(after.imported[0]).not.toBe(first);
  expect(await (await post("read_concept", { id: first })).json()).toMatchObject({
    result: { body: "Local edited content.\n" },
  });
  expect((await upload("markdown", changed, { preview: update.preview, selected: [1] })).status).toBe(400);
  const history = await fetch(server.url + "api/personal/sources/history", { headers: { "x-okb-token": TOKEN } });
  expect(history.headers.get("cache-control")).toBe("no-store");
  expect(await history.json()).toMatchObject({ result: [
    { kind: "markdown", source: "My archive", count: 1, notes: [{ id: after.imported[0], title: "First updated" }] },
    { kind: "markdown", source: "My archive", count: 2 },
  ] });
});

test("bookmark import retains folder hints, refuses unsupported URLs, and checks mount policy", async () => {
  const files: [string, string][] = [["bookmarks.html", `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>Work &amp; Ideas</H3>
    <DL><p>
        <DT><H3>Writing</H3>
        <DL><p>
            <DT><A HREF="https://example.com/first" ADD_DATE="1724103000">Ideas &amp; Drafts</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="javascript:void(0)">Unsupported</A>
    <DT><A HREF="https://example.com/first">Duplicate address</A>
</DL><p>`]];
  const readonly = createApiServer({ bundle: root, port: 0, token: TOKEN, readonly: true });
  try {
    expect((await upload("bookmarks", files, undefined, server, false)).status).toBe(401);
    expect((await upload("bookmarks", files, undefined, readonly)).status).toBe(403);
    expect((await upload("markdown", [["../note.md", "# Escape"]])).status).toBe(400);
    const preview = await receipt(await upload("bookmarks", files));
    expect(preview.rows.map((row) => row.status)).toEqual(["new", "skipped", "skipped"]);
    expect(preview.rows[0]).toMatchObject({
      path: "bookmarks.html · Work & Ideas / Writing",
      title: "Ideas & Drafts",
      excerpt: "https://example.com/first",
    });
    const saved = await receipt(await upload("bookmarks", files, { preview: preview.preview, selected: [1] }));
    expect(await (await post("read_concept", { id: saved.imported[0] })).json()).toMatchObject({
      result: { frontmatter: {
        type: "reference",
        resource: "https://example.com/first",
        sources: [{ folder: "Work & Ideas / Writing", saved_at_unix: "1724103000" }],
      } },
    });
  } finally {
    readonly.stop();
  }
});

test("Notion export page IDs recognize renamed text and CSV stays visible in preview", async () => {
  const page = "0123456789abcdef0123456789abcdef";
  const files: [string, string][] = [[`Workspace/Page ${page}.md`, "Current text"], ["Workspace/Table.csv", "A,B\n1,2"]];
  const preview = await receipt(await upload("notion", files));
  expect(preview.rows).toMatchObject([{ title: "Page", status: "new" }, { status: "skipped" }]);
  const saved = await receipt(await upload("notion", files, { preview: preview.preview, selected: [1] }));
  const rename = await receipt(await upload("notion", [[`New title ${page}.md`, "Current text"]]));
  expect(rename.rows[0]).toMatchObject({ title: "New title", status: "changed", previous: saved.imported[0] });
});

test("the browser commits a selected live Notion snapshot after read-only consent", async () => {
  const page = "0123456789abcdef0123456789abcdef";
  const connectionToken = "ntn_" + "fake".repeat(12);
  const tokenPath = join(root, "state", "notion", "token");
  const seen: string[] = [];
  let upstream = "# Page from Notion\n\nOriginal snapshot.\n\n![Media](https://example.com/pixel)\n";
  server.stop();
  server = createApiServer({ bundle: root, port: 0, token: TOKEN, notion: {
    path: tokenPath,
    fetch: async (url, request) => {
      seen.push(url.href);
      expect(url.origin).toBe("https://api.notion.com");
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("error");
      expect(new Headers(request.headers).get("Authorization")).toBe("Bearer " + connectionToken);
      return Response.json({ object: "page_markdown", id: page, markdown: upstream, truncated: false, unknown_block_ids: [] });
    },
  } });

  const route = (action: string, body?: unknown, target = server) => fetch(target.url + "api/personal/sources/notion/" + action, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-okb-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const selection = { name: "Work Notion", page: `https://example.notion.site/My-Page-${page}?pvs=4` };
  expect(await (await route("status")).json()).toMatchObject({ result: { connected: false } });
  expect((await route("connect", { token: connectionToken })).status).toBe(400);
  expect((await route("preview", selection)).status).toBe(409);
  expect(await (await route("connect", { token: connectionToken, allow: true })).json()).toEqual({ result: { connected: true } });
  expect(seen).toHaveLength(0);
  expect(await Bun.file(tokenPath).text()).toBe(connectionToken + "\n");
  expect((await route("preview", { ...selection, page: `https://evil.example/${page}` })).status).toBe(400);
  expect(seen).toHaveLength(0);
  const response = await route("preview", selection);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { result: preview } = await response.json() as { result: { previewId: string; markdown: string; rows: { id: string }[] } };
  expect(preview.markdown).toContain("Original snapshot.");
  expect(preview.markdown).not.toContain("https://example.com/pixel");
  const id = preview.rows[0]!.id;
  expect((await post("read_concept", { id })).status).toBe(404);

  upstream = "# Page from Notion\n\nChanged remotely after preview.";
  const confirmed = await receipt(await route("import", { previewId: preview.previewId }));
  expect(confirmed.imported).toEqual([id]);
  expect(seen).toEqual([`https://api.notion.com/v1/pages/${page}/markdown?include_transcript=false&markdown_version=v2`]);
  expect(await (await post("read_concept", { id })).json()).toMatchObject({
    result: {
      body: expect.stringContaining("Original snapshot."),
      frontmatter: {
        resource: `https://www.notion.so/${page}`,
        status: "draft",
        sources: [{ resource: `https://www.notion.so/${page}`, notion_page_id: page }],
      },
    },
  });
  const history = await fetch(server.url + "api/personal/sources/history", { headers: { "x-okb-token": TOKEN } });
  expect(await history.json()).toMatchObject({ result: [{ kind: "notion-live", source: "Work Notion", count: 1 }] });
  const readonly = createApiServer({ bundle: root, port: 0, token: TOKEN, readonly: true, notion: { path: tokenPath } });
  try {
    expect((await route("preview", selection, readonly)).status).toBe(403);
    expect((await route("disconnect", {}, readonly)).status).toBe(403);
  } finally {
    readonly.stop();
  }
  expect(await (await route("disconnect", {})).json()).toEqual({ result: { connected: false } });
  expect(await Bun.file(tokenPath).exists()).toBe(false);
  expect((await route("import", { previewId: preview.previewId })).status).toBe(400);
});
