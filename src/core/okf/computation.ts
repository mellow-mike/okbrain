import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeVerified, parse, type OkfDocument } from "./document.ts";
import { inDbOnlyDir, isReservedName } from "./paths.ts";
import { isPrivateConcept } from "./privacy.ts";
import { nowTimestamp, writeConcept } from "./write.ts";

export const computationRuntime = "okbrain/csv-aggregate-v1";
const attestationActor = "process:okbrain-csv-aggregate-v1";
const maxSource = 256 * 1024;
const maxReceipt = 16 * 1024;
const maxRows = 10000;
const maxColumns = 32;
const maxCell = 4096;
const integer = /^-?(?:0|[1-9][0-9]{0,15})$/u;
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;

type Parameter = { name: string; type: "string" | "integer" | "boolean"; required: true };
type Value = string | number | boolean;
type Contract = {
  runtime: typeof computationRuntime;
  parameters: Parameter[];
  executor: { source: string; operation: "count" | "sum"; column?: string; filters: { column: string; parameter: string }[] };
  attester: { method: "recompute" };
};

export class ComputationError extends Error {
  constructor(message: string, readonly code: "bad_params" | "not_found" | "refused" = "bad_params") { super(message); }
}

function digest(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ComputationError("Expected a JSON object.");
  return input as Record<string, unknown>;
}

function keys(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new ComputationError("The CSV computation contains an unsupported setting.");
}

function json(input: string, label: string): Record<string, unknown> {
  if (Buffer.byteLength(input) > maxReceipt) throw new ComputationError(`${label} exceeds 16 KiB.`);
  try { return record(JSON.parse(input)); }
  catch { throw new ComputationError(`Enter ${label.toLowerCase()} as a JSON object.`); }
}

function parts(path: string) {
  const segments = path.split("/");
  if (Buffer.byteLength(path) > 512 || segments.length > 16 || segments.some((segment) =>
    !segment || segment.startsWith(".") || segment === "node_modules" || /[\\:*?"<>|\u0000-\u001f\u007f]|[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new ComputationError("Choose an ordinary relative file path within this brain.");
  }
  return segments;
}

async function readBytes(root: string, path: string, maximum: number, label: string): Promise<Buffer> {
  const segments = parts(path);
  let candidate = root;
  try {
    let checked;
    for (const [index, segment] of segments.entries()) {
      candidate = join(candidate, segment);
      checked = await lstat(candidate);
      if (index === segments.length - 1 ? !checked.isFile() || checked.nlink !== 1 : !checked.isDirectory())
        throw new ComputationError(`${label} must be an ordinary file in this brain.`);
    }
    const file = await open(candidate, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== checked!.dev || opened.ino !== checked!.ino
        || await realpath(candidate) !== candidate)
        throw new ComputationError(`${label} changed while opening it. Preview it again.`);
      if (opened.size > maximum) throw new ComputationError(`${label} exceeds the ${maximum / 1024} KiB limit.`);
      const bytes = Buffer.alloc(opened.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      const current = await file.stat();
      if (size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.size !== opened.size)
        throw new ComputationError(`${label} changed while reading it. Preview it again.`);
      return bytes.subarray(0, size);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof ComputationError) throw error;
    throw new ComputationError(`Could not read ${label.toLowerCase()} inside this brain.`,
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "bad_params");
  }
}

function utf8(bytes: Buffer, label: string) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error();
    return text;
  } catch { throw new ComputationError(`${label} must be UTF-8 text.`); }
}

async function readContractNote(bundle: string, id: string) {
  if (!id || isReservedName(`${id.split("/").at(-1)}.md`)) throw new ComputationError("Choose a computation concept.");
  const root = await realpath(bundle).catch(() => { throw new ComputationError("The selected brain is unavailable.", "not_found"); });
  const raw = utf8(await readBytes(root, `${id}.md`, 256 * 1024, "Computation concept"), "The computation concept");
  let doc: OkfDocument;
  try { doc = parse(raw); }
  catch { throw new ComputationError("The concept has unreadable frontmatter."); }
  if (String(doc.frontmatter.type).toLowerCase() !== "attested computation")
    throw new ComputationError("Choose an Attested Computation concept.");
  return { root, raw, doc };
}

function column(input: unknown): string {
  if (typeof input !== "string" || !identifier.test(input)) throw new ComputationError("Use a CSV column or parameter name of up to 64 letters, digits, dashes, or underscores.");
  return input;
}

function contract(input: Record<string, unknown>): Contract {
  if (input.runtime !== computationRuntime) throw new ComputationError("Only the built-in CSV aggregate runtime can run locally.", "refused");
  if (!Array.isArray(input.parameters) || input.parameters.length > 4)
    throw new ComputationError("Declare up to four typed filter parameters.");
  const parameters: Parameter[] = input.parameters.map((item) => {
    const declaration = record(item);
    keys(declaration, ["name", "type", "required"]);
    const { type } = declaration;
    if (!(type === "string" || type === "integer" || type === "boolean") || declaration.required !== true)
      throw new ComputationError("Declare required string, integer, or boolean parameters.");
    return { name: column(declaration.name), type, required: true };
  });
  const executor = record(input.executor);
  keys(executor, ["source", "operation", "column", "filters"]);
  const { source, operation } = executor;
  if (typeof source !== "string" || !source.endsWith(".csv"))
    throw new ComputationError("Enter the relative path of a CSV file in this brain.");
  parts(source);
  if (operation !== "count" && operation !== "sum") throw new ComputationError("Choose a count or integer sum.");
  if (operation === "count" && executor.column !== undefined) throw new ComputationError("A row count does not need a sum column.");
  const filters = executor.filters ?? [];
  if (!Array.isArray(filters) || filters.length !== parameters.length)
    throw new ComputationError("Declare exactly one filter for each parameter.");
  const bindings = filters.map((item) => {
    const filter = record(item);
    keys(filter, ["column", "parameter"]);
    return { column: column(filter.column), parameter: column(filter.parameter) };
  });
  const names = new Set(parameters.map(({ name }) => name));
  if (names.size !== parameters.length || bindings.some(({ parameter }) => !names.delete(parameter)) || names.size)
    throw new ComputationError("Each filter must use a different declared parameter.");
  const attester = record(input.attester);
  keys(attester, ["method"]);
  if (attester.method !== "recompute") throw new ComputationError("Choose the built-in recompute attester.");
  return { runtime: computationRuntime, parameters, executor: { source, operation,
    ...(operation === "sum" ? { column: column(executor.column) } : {}), filters: bindings }, attester: { method: "recompute" } };
}

function boundParameters(declared: Parameter[], supplied: Record<string, unknown>): Record<string, Value> {
  keys(supplied, declared.map(({ name }) => name));
  return Object.fromEntries(declared.map(({ name, type }) => {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    if (type === "string" && typeof value === "string" && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
      || type === "integer" && typeof value === "number" && Number.isSafeInteger(value)
      || type === "boolean" && typeof value === "boolean") return [name, (value === 0 ? 0 : value) as Value];
    throw new ComputationError(`Enter a ${type} value for ${name}.`);
  }));
}

async function loadPlan(bundle: string, id: string, supplied: Record<string, unknown>) {
  const note = await readContractNote(bundle, id);
  const spec = contract(note.doc.frontmatter);
  const path = spec.executor.source;
  if (inDbOnlyDir(path.toLowerCase()) && !isPrivateConcept(id, note.doc.frontmatter))
    throw new ComputationError("Use a private computation concept for a source under db_only/.", "refused");
  const parameters = boundParameters(spec.parameters, supplied);
  const bytes = await readBytes(note.root, path, maxSource, "CSV source");
  const source = { path, sha256: digest(bytes), bytes: bytes.length };
  const contractDigest = digest(JSON.stringify(spec));
  const planDigest = digest(JSON.stringify([1, id, contractDigest, source, parameters]));
  return { note, id, spec, source, text: utf8(bytes, "The CSV source"), parameters, contractDigest, planDigest };
}

type Plan = Awaited<ReturnType<typeof loadPlan>>;

function csvRows(text: string) {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  const malformed = () => new ComputationError(`Invalid CSV at row ${rows.length + 1}.`);
  const pushField = () => {
    if (fields.length >= maxColumns || field.length > maxCell) throw malformed();
    fields.push(field);
    field = "";
    state = "plain";
  };
  const pushRow = () => {
    pushField();
    if (rows.length > maxRows || (rows[0] && fields.length !== rows[0].length)) throw malformed();
    rows.push(fields);
    fields = [];
  };
  for (let i = text.startsWith("\uFEFF") ? 1 : 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === "quoted") {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += char; i++; }
      else state = "closed";
    } else if (char === ",") pushField();
    else if (char === "\n" || char === "\r") {
      pushRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (state === "closed") throw malformed();
    else if (char === '"') {
      if (field) throw malformed();
      state = "quoted";
    } else field += char;
    if (field.length > maxCell) throw malformed();
  }
  if (state === "quoted") throw malformed();
  if (fields.length || field || state === "closed") pushRow();
  if (!rows[0]?.every((name) => identifier.test(name)) || new Set(rows[0]).size !== rows[0].length)
    throw new ComputationError("The CSV needs a header of unique column names.");
  return { header: rows[0], rows: rows.slice(1) };
}

function result(plan: Plan) {
  const { header, rows } = csvRows(plan.text);
  const { executor, parameters } = plan.spec;
  const index = (name: string) => {
    const i = header.indexOf(name);
    if (i === -1) throw new ComputationError(`The CSV is missing column ${name}.`);
    return i;
  };
  const filters = executor.filters.map(({ column, parameter }) =>
    ({ index: index(column), value: plan.parameters[parameter]!, type: parameters.find(({ name }) => name === parameter)!.type }));
  const sumColumn = executor.column === undefined ? undefined : index(executor.column);
  let matchedRows = 0;
  let value = 0n;
  for (const [rowIndex, row] of rows.entries()) {
    let match = true;
    for (const filter of filters) {
      const cell = row[filter.index]!;
      if (filter.type === "integer" && !integer.test(cell) || filter.type === "boolean" && cell !== "true" && cell !== "false")
        throw new ComputationError(`CSV row ${rowIndex + 2} has an invalid typed filter value.`);
      const equal = filter.type === "integer" ? BigInt(cell) === BigInt(filter.value as number) : cell === String(filter.value);
      match = match && equal;
    }
    if (!match) continue;
    matchedRows++;
    if (sumColumn === undefined) value++;
    else if (integer.test(row[sumColumn]!)) value += BigInt(row[sumColumn]!);
    else throw new ComputationError(`CSV row ${rowIndex + 2} has an invalid integer sum value.`);
  }
  return { operation: executor.operation, rowCount: rows.length, matchedRows, value: value.toString() };
}

function receipt(plan: Plan) {
  const record = { version: 1, concept: plan.id, runtime: computationRuntime, source: plan.source, parameters: plan.parameters,
    contractDigest: plan.contractDigest, planDigest: plan.planDigest, result: result(plan) };
  return { ...record, digest: digest(JSON.stringify(record)) };
}

export async function previewComputation(bundle: string, id: string, input: string) {
  const plan = await loadPlan(bundle, id, json(input, "Parameters"));
  return { concept: id, contract: plan.spec, source: { ...plan.source, text: plan.text }, parameters: plan.parameters, approval: plan.planDigest };
}

export async function compute(bundle: string, id: string, input: string, approval: string) {
  const plan = await loadPlan(bundle, id, json(input, "Parameters"));
  if (plan.planDigest !== approval) throw new ComputationError("The source, contract, or parameters changed. Preview and approve them again.", "refused");
  return receipt(plan);
}

async function verifiedPlan(bundle: string, id: string, input: string) {
  const claimed = json(input, "Receipt");
  if (claimed.concept !== id || claimed.runtime !== computationRuntime || claimed.version !== 1)
    throw new ComputationError("The receipt belongs to a different computation or runtime.");
  const plan = await loadPlan(bundle, id, record(claimed.parameters));
  const expected = receipt(plan);
  if (!isDeepStrictEqual(expected, claimed)) throw new ComputationError("The receipt does not match recomputation from the current contract and original source.", "refused");
  return { plan, receipt: expected, approval: digest(JSON.stringify(["attest", expected.digest])) };
}

export async function verifyComputation(bundle: string, id: string, input: string) {
  const verified = await verifiedPlan(bundle, id, input);
  return { receipt: verified.receipt, approval: verified.approval, verified: true };
}

export async function attestComputation(bundle: string, id: string, input: string, approval: string) {
  const { plan, receipt: confirmed, approval: expected } = await verifiedPlan(bundle, id, input);
  if (approval !== expected) throw new ComputationError("Verify the receipt and confirm the attestation again.", "refused");
  const at = nowTimestamp();
  const evidence = { runtime: computationRuntime, receipt_digest: confirmed.digest, contract_digest: confirmed.contractDigest,
    plan_digest: confirmed.planDigest, source_sha256: confirmed.source.sha256 };
  const previous = plan.note.doc.frontmatter;
  const existing = normalizeVerified(previous).find(({ by }) => by === attestationActor);
  if (existing?.at && isDeepStrictEqual(previous.computation_verification, evidence))
    return { id, by: attestationActor, at: existing.at, receipt: confirmed, reused: true };
  await writeConcept(plan.note.root, {
    id, metadataOnly: true, verify: { by: attestationActor, at }, extra: { computation_verification: evidence },
  }, { expected: plan.note.raw });
  return { id, by: attestationActor, at, receipt: confirmed, reused: false };
}

export async function configureComputation(bundle: string, id: string, input: string) {
  const note = await readContractNote(bundle, id);
  const frontmatter = note.doc.frontmatter;
  if (frontmatter.runtime !== undefined && frontmatter.runtime !== computationRuntime)
    throw new ComputationError("This concept declares an external runtime. Keep its original contract for reference.", "refused");
  const config = json(input, "Contract");
  keys(config, ["parameters", "executor"]);
  const spec = contract({ ...config, runtime: computationRuntime, attester: { method: "recompute" } });
  if (inDbOnlyDir(spec.executor.source.toLowerCase()) && !isPrivateConcept(id, frontmatter))
    throw new ComputationError("Use a private computation concept for a source under db_only/.", "refused");
  let unchanged = false;
  try { unchanged = isDeepStrictEqual(contract(frontmatter), spec); } catch { /* Replace an incomplete local contract. */ }
  if (!unchanged) await writeConcept(note.root, {
    id, extra: { ...spec, computation_verification: undefined },
    verified: normalizeVerified(frontmatter).filter(({ by }) => by !== attestationActor),
  }, { expected: note.raw });
  return { id, contract: spec };
}
