import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");
const binary = join(repository, "bin", process.platform === "win32" ? "okb.exe" : "okb");
const root = await mkdtemp(join(tmpdir(), "okbrain-perf-"));
const bundle = join(root, "brain");
const config = join(root, "config");
const data = join(root, "data");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OKB_"))),
  XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, APPDATA: config, LOCALAPPDATA: data,
};
const notes = 1024;
const spawn = (args: string[]) => Bun.spawn([binary, ...args, "--bundle", bundle], {
  env, cwd: repository, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(30_000),
});

async function index() {
  const start = performance.now();
  const child = spawn(["index", "--json"]);
  const [code, output, errors] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, errors);
  assert.equal(JSON.parse(output).indexed, notes);
  return performance.now() - start;
}

async function startApp(searches?: number[]) {
  const start = performance.now();
  const child = spawn(["serve", "--desktop"]);
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`The app exited before reporting its address. ${await errors}`);
      line += value;
    }
    const url = new URL(line.split("\n", 1)[0]!.trim());
    assert.equal(url.hostname, "127.0.0.1");
    const page = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>okbrain<\/title>/i);
    const elapsed = performance.now() - start;

    if (searches) {
      const token = (await readFile(join(config, "okbrain", "serve-token"), "utf8")).trim();
      for (let sample = 0; sample <= 25; sample++) {
        const record = (sample * 37) % notes;
        const began = performance.now();
        const response = await fetch(new URL("/api/op/search", url), {
          method: "POST", signal: AbortSignal.timeout(5000),
          headers: { "x-okb-token": token, "Content-Type": "application/json" },
          body: JSON.stringify({ query: `record${record} offline`, "keyword-only": true }),
        });
        assert.equal(response.status, 200);
        const payload = await response.json() as { result: { id: string }[] };
        if (sample > 0) searches.push(performance.now() - began);
        assert.equal(payload.result[0]?.id, `notes/note-${record}`);
      }
    }
    return elapsed;
  } finally {
    child.kill();
    reader.releaseLock();
    await Promise.all([child.exited, errors]);
  }
}

function metric(label: string, values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(values.length * fraction) - 1]!.toFixed(1);
  return `| ${label} | ${values.length} | ${percentile(0.5)} | ${percentile(0.95)} |`;
}

try {
  const folder = join(bundle, "notes");
  await mkdir(folder, { recursive: true });
  for (let start = 0; start < notes; start += 32) {
    await Promise.all(Array.from({ length: 32 }, (_, offset) => {
      const i = start + offset;
      const prior = (i + notes - 1) % notes;
      return writeFile(join(folder, `note-${i}.md`), `---\ntype: note\ntitle: Note ${i}\ndescription: Benchmark record ${i}\n---\n\n` +
        `This offline note records record${i} in a synthetic knowledge bundle. See [prior note](/notes/note-${prior}.md).\n`);
    }));
  }
  const rebuilds: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    await rm(join(bundle, ".okb"), { recursive: true, force: true });
    rebuilds.push(await index());
  }
  const starts: number[] = [];
  const searches: number[] = [];
  for (let sample = 0; sample < 11; sample++) starts.push(await startApp(sample === 10 ? searches : undefined));
  console.log(`### Personal app latency on ${platform()} ${arch()}\n\n` +
    `Compiled app and ${notes} linked Markdown notes with local SQLite. Each app start uses a new process.\n\n` +
    "| Operation | Samples | p50 (ms) | p95 (ms) |\n| --- | ---: | ---: | ---: |\n" +
    [metric("Process launch to first HTML response", starts), metric("Fresh keyword and graph index", rebuilds),
      metric("Warm keyword search API", searches)].join("\n"));
} finally {
  await rm(root, { recursive: true, force: true });
}
