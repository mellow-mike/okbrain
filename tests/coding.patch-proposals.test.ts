import { expect, test } from "bun:test";
import { codingPatchProposals } from "../src/core/coding/patch-proposals.ts";

function patch(path: string, version: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+${version}\n`;
}

test("returns the exact saved diff from a complete fence or a raw Git patch", () => {
  const diff = patch("src/main.ts", "new text 🚀  ");
  const proposal = { paths: ["src/main.ts"], diff };
  expect(codingPatchProposals(`Replace the existing text.\n\n\`\`\`diff\n${diff}\`\`\`\n`, ["src"])).toEqual([proposal]);
  expect(codingPatchProposals(diff, ["."])).toEqual([proposal]);
  expect(codingPatchProposals("Example with CRLF.\r\n```diff\r\n" + diff.replaceAll("\n", "\r\n") + "```\r\n", ["src"])).toEqual([]);
  expect(codingPatchProposals(diff.trimEnd(), ["src"])).toEqual([]);
});

test("skips nested examples, incomplete fences, malformed patches, and out-of-scope paths", () => {
  const diff = patch("src/main.ts", "valid patch");
  const hidden = "````markdown\n```diff\n" + diff + "```\n````\n";
  const wrong = "```diff\n" + patch("separate/private.ts", "do not include") + "```\n";
  const malformed = "```diff\n" + diff.replace("+valid patch", "valid patch") + "```\n";
  const incomplete = "```diff\n" + diff;
  expect(codingPatchProposals(hidden + wrong + malformed + incomplete, ["src"])).toEqual([]);
});

test("deduplicates identical diff text and bounds the number and size of proposals", () => {
  const diffs = Array.from({ length: 6 }, (_, index) => patch(`src/file${index}.ts`, `revision ${index}`));
  const fenced = (diff: string) => "~~~patch\n" + diff + "~~~\n";
  const answer = fenced(diffs[0]!) + diffs.map(fenced).join("\n");
  expect(codingPatchProposals(answer, ["src"]).map(({ diff }) => diff)).toEqual(diffs.slice(0, 4));
  expect(codingPatchProposals(fenced(patch("src/main.ts", "x".repeat(49 * 1024))), ["."])).toEqual([]);
  expect(codingPatchProposals("x".repeat(513 * 1024) + "\n" + fenced(diffs[0]!), ["src"])).toEqual([]);
});
