// Text features for the repository atlas: identifier-aware terms for lexical
// search, and a deterministic hashed embedding that needs no model. The
// encoder is corpus-aware only through a document-frequency table saved with
// the atlas, so an unchanged unit keeps the same vector between imports.

export const embeddingDim = 256;
export const dfBuckets = 1 << 16;

const noise = new Set([
  // English function words.
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from", "has", "have", "how", "i", "if", "in",
  "into", "is", "it", "its", "may", "must", "no", "not", "of", "on", "or", "our", "should", "so", "such", "than", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "we", "what", "when", "where", "which", "while", "who", "why",
  "will", "with", "would", "you", "your",
  // Syntax that appears in almost every source file.
  "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "else", "end", "enum", "export",
  "extends", "false", "final", "fn", "func", "function", "import", "impl", "interface", "let", "new", "nil", "none", "null",
  "package", "private", "protected", "pub", "public", "return", "self", "static", "struct", "switch", "true", "try", "type",
  "undefined", "use", "var", "void",
]);

/** Split `refreshSessionToken`, `refresh_session` and `HTTPServer2` into their words. */
export function splitIdentifier(token: string): string[] {
  return token
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .split(/[\s_$]+/u)
    .filter(Boolean);
}

/** A conservative suffix stripper: enough to join plurals and simple inflections. */
export function stem(word: string): string {
  if (word.length < 5 || /[^a-z]/u.test(word)) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5 && !word.endsWith("eed")) return word.slice(0, -2);
  if (word.endsWith("s") && !/(?:ss|us|is)$/u.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Terms for one piece of text: every whole identifier (lowercased) plus its
 * stemmed words. A whole identifier keeps exact-name matches strong while the
 * words let `refresh session` find `refreshSession`.
 */
export function addTerms(into: Map<string, number>, text: string, weight: number, limit = 4096): void {
  let seen = 0;
  for (const match of text.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*|\p{N}+/gu)) {
    if (seen++ >= limit) break;
    const whole = match[0].toLowerCase();
    if (whole.length > 64) continue;
    const words = splitIdentifier(match[0]).map((word) => word.toLowerCase());
    if (words.length > 1 && !noise.has(whole)) into.set(whole, (into.get(whole) ?? 0) + weight);
    for (const word of words) {
      if (word.length < 2 || noise.has(word)) continue;
      const term = stem(word);
      into.set(term, (into.get(term) ?? 0) + weight);
    }
  }
}

export function terms(text: string, limit?: number): Map<string, number> {
  const bag = new Map<string, number>();
  addTerms(bag, text, 1, limit);
  return bag;
}

export interface QueryFeatures {
  terms: Map<string, number>;
  /** Identifiers that look specific: camelCase, snake_case, digits, or the only word given. */
  identifiers: string[];
  /** Tokens that look like workspace-relative paths. */
  paths: string[];
}

export function queryFeatures(query: string): QueryFeatures {
  const bag = terms(query, 256);
  const names = query.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? [];
  const meaningful = names.filter((name) => !noise.has(name.toLowerCase()));
  const identifiers = [...new Set(meaningful.filter((name) =>
    meaningful.length === 1 || /[\p{Ll}\p{N}]\p{Lu}|\p{Lu}{2}\p{Ll}|[_$\d]/u.test(name)).map((name) => name.toLowerCase()))].slice(0, 16);
  const paths = [...new Set(query.split(/\s+/u)
    .map((token) => token.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/:\d+(?:[:-]\d+)?$/u, "").replace(/[),.;'"`]+$/u, "").replace(/^['"`(]+/u, ""))
    .filter((token) => token.includes("/") || /\.[a-z0-9]{1,8}$/iu.test(token))
    .map((token) => token.toLowerCase()))].slice(0, 16);
  return { terms: bag, identifiers, paths };
}

/** A quoted OR query for FTS5, so punctuation in a task never becomes an operator. */
export function ftsQuery(bag: Map<string, number>, limit = 24): string {
  return [...bag.keys()].filter((term) => /^[\p{L}\p{N}_$]+$/u.test(term)).slice(0, limit).map((term) => `"${term}"`).join(" OR ");
}

/** FNV-1a over UTF-16 code units. Stable across platforms and Bun versions. */
export function hash32(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export const dfBucket = (term: string): number => hash32(term) & (dfBuckets - 1);

export interface DocumentFrequencies {
  documents: number;
  counts: Uint32Array;
}

export function emptyFrequencies(): DocumentFrequencies {
  return { documents: 0, counts: new Uint32Array(dfBuckets) };
}

export function countDocument(frequencies: DocumentFrequencies, bag: Map<string, number>): void {
  frequencies.documents++;
  const seen = new Set<number>();
  for (const term of bag.keys()) seen.add(dfBucket(term));
  for (const bucket of seen) frequencies.counts[bucket] = (frequencies.counts[bucket] ?? 0) + 1;
}

/** BM25's idf. Hash collisions only ever lower a weight, never raise it. */
export function inverseFrequency(frequencies: DocumentFrequencies | undefined, term: string): number {
  if (!frequencies || frequencies.documents === 0) return 1;
  const df = Math.min(frequencies.counts[dfBucket(term)] ?? 0, frequencies.documents);
  return Math.log(1 + (frequencies.documents - df + 0.5) / (df + 0.5));
}

function scatter(vector: Float32Array, feature: string, weight: number): void {
  // Two signed hash positions per feature (a two-row count sketch folded into
  // one vector) halve the variance a single colliding bucket would add.
  const first = hash32(feature);
  const second = hash32(feature, 0x9747b28c);
  const share = weight * Math.SQRT1_2;
  const a = first % embeddingDim;
  const b = second % embeddingDim;
  vector[a] = (vector[a] ?? 0) + ((first >>> 16) & 1 ? share : -share);
  vector[b] = (vector[b] ?? 0) + ((second >>> 16) & 1 ? share : -share);
}

/**
 * Hash a weighted bag of terms into a unit vector. Character trigrams carry a
 * quarter of each term's weight so `auth` and `authenticate` land near each
 * other without a learned vocabulary.
 */
export function embedBag(bag: Map<string, number>, frequencies?: DocumentFrequencies): Float32Array {
  const vector = new Float32Array(embeddingDim);
  for (const [term, raw] of bag) {
    const weight = (1 + Math.log(Math.max(raw, 1e-6) + 1)) * inverseFrequency(frequencies, term);
    if (weight <= 0) continue;
    scatter(vector, term, weight);
    if (term.length >= 4 && term.length <= 32) {
      const padded = `<${term}>`;
      const share = (weight * 0.25) / Math.sqrt(padded.length - 2);
      for (let index = 0; index + 3 <= padded.length; index++) scatter(vector, `#${padded.slice(index, index + 3)}`, share);
    }
  }
  normalize(vector);
  return vector;
}

export function normalize(vector: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < vector.length; index++) sum += vector[index]! * vector[index]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let index = 0; index < vector.length; index++) vector[index] = vector[index]! / norm;
  return norm;
}

/** Store a unit vector as signed bytes. The scale is recovered in `cosine`. */
export function quantize(vector: Float32Array, out: Int8Array, offset: number): void {
  for (let index = 0; index < embeddingDim; index++) {
    out[offset + index] = Math.max(-127, Math.min(127, Math.round((vector[index] ?? 0) * 127)));
  }
}

export function dequantize(source: Int8Array, offset: number): Float32Array {
  const vector = new Float32Array(embeddingDim);
  for (let index = 0; index < embeddingDim; index++) vector[index] = (source[offset + index] ?? 0) / 127;
  return vector;
}

/** The coordinates a query vector actually uses. A short task touches a fraction of them. */
export interface SparseVector { index: Uint16Array; weight: Float32Array }

export function sparseVector(vector: Float32Array): SparseVector {
  const index: number[] = [];
  for (let at = 0; at < vector.length; at++) if (vector[at] !== 0) index.push(at);
  return { index: Uint16Array.from(index), weight: Float32Array.from(index, (at) => vector[at]!) };
}

/** Dot product of a query with one quantized row, in cosine units. This loop runs once per unit for every readout. */
export function rowDot(query: SparseVector, rows: Int8Array, offset: number): number {
  const { index, weight } = query;
  const length = index.length;
  let sum = 0;
  let at = 0;
  for (; at + 4 <= length; at += 4) {
    sum += weight[at]! * rows[offset + index[at]!]! + weight[at + 1]! * rows[offset + index[at + 1]!]!
      + weight[at + 2]! * rows[offset + index[at + 2]!]! + weight[at + 3]! * rows[offset + index[at + 3]!]!;
  }
  for (; at < length; at++) sum += weight[at]! * rows[offset + index[at]!]!;
  return sum / 127;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += a[index]! * (b[index] ?? 0);
  return sum;
}

/** Accumulate `weight × row` into a float vector. */
export function addRow(into: Float32Array, rows: Int8Array, offset: number, weight: number): void {
  const scale = weight / 127;
  for (let index = 0; index < embeddingDim; index++) into[index] = into[index]! + rows[offset + index]! * scale;
}

/** A deterministic unit-interval draw from a string, for seeded choices. */
export function unitDraw(text: string): number {
  return hash32(text, 0x2545f491) / 0x1_0000_0000;
}

/** Estimated tokens for serialized context, the same rule the existing previews use. */
export const estimateTokens = (bytes: number): number => Math.ceil(bytes / 2);
