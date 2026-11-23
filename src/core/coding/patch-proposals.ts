import { ApprovedPatchError, patchPaths } from "./approved-patch.ts";

const maxAnswerBytes = 512 * 1024;
const maxProposals = 4;
const fencePattern = /^ {0,3}(`{3,}|~{3,})/u;

export interface CodingPatchProposal {
  diff: string;
  paths: string[];
}

/** Select complete Git patches from a saved answer while preserving the exact diff text. */
export function codingPatchProposals(text: string, scopes: readonly string[]): CodingPatchProposal[] {
  if (Buffer.byteLength(text) > maxAnswerBytes) return [];
  const proposals: CodingPatchProposal[] = [];
  const seen = new Set<string>();
  function add(diff: string) {
    if (seen.has(diff) || /[\uD800-\uDFFF]/u.test(diff)) return;
    try {
      const paths = patchPaths(diff);
      if (paths.every((path) => scopes.some((scope) => scope === "." || path.startsWith(`${scope}/`)))) {
        seen.add(diff);
        proposals.push({ diff, paths });
      }
    } catch (error) {
      if (!(error instanceof ApprovedPatchError)) throw error;
    }
  }
  if (text.startsWith("diff --git ")) add(text);
  if (proposals.length) return proposals;

  let fence: { marker: string; start: number; diff: boolean } | undefined;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const match = fencePattern.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    const info = line.slice(match[0].length).replace(/\r$/u, "");
    if (info.includes("\r")) continue;
    if (fence) {
      if (marker[0] !== fence.marker[0] || marker.length < fence.marker.length || !/^[ \t]*$/u.test(info)) continue;
      if (fence.diff) add(text.slice(fence.start, start));
      fence = undefined;
      if (proposals.length === maxProposals) break;
    } else if (marker[0] !== "`" || !info.includes("`")) {
      fence = { marker, start: offset, diff: /^(?:diff|patch)(?:[ \t]|$)/iu.test(info.trimStart()) };
    }
  }
  return proposals;
}
