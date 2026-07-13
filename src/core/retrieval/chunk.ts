// ~400-token chunker (2.2), tokens approximated as chars/4 so no tokenizer
// dependency and no provider coupling. Deterministic: split on blank lines,
// greedily pack whole blocks, split an oversize block by line, hard-split an
// oversize line. Chunk text is stored verbatim in the vector store, so this
// must stay stable — changing it invalidates nothing by itself (the embed
// pipeline's content hash covers inputs, not chunk boundaries).

export interface Chunk {
  seq: number;
  text: string;
}

/** ≈400 tokens at ~4 chars/token. */
export const MAX_CHUNK_CHARS = 1600;

export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): Chunk[] {
  const pieces: string[] = [];
  for (const block of text.replaceAll("\r\n", "\n").split(/\n{2,}/)) {
    const b = block.trim();
    if (b === "") continue;
    if (b.length <= maxChars) {
      pieces.push(b);
      continue;
    }
    let acc = "";
    const flush = () => {
      if (acc !== "") pieces.push(acc);
      acc = "";
    };
    for (const line of b.split("\n"))
      for (let i = 0; i < line.length; i += maxChars) {
        const part = line.slice(i, i + maxChars);
        if (acc !== "" && acc.length + 1 + part.length > maxChars) flush();
        acc = acc === "" ? part : `${acc}\n${part}`;
      }
    flush();
  }
  const out: Chunk[] = [];
  let acc = "";
  for (const p of pieces) {
    if (acc !== "" && acc.length + 2 + p.length > maxChars) {
      out.push({ seq: out.length, text: acc });
      acc = "";
    }
    acc = acc === "" ? p : `${acc}\n\n${p}`;
  }
  if (acc !== "") out.push({ seq: out.length, text: acc });
  return out;
}
