import { createHash } from "node:crypto";
import type { OrchestrationPlan } from "./orchestrator.ts";
import type { RepositoryContextManifest } from "./repository-context.ts";
import type { OpenRouterPreferences, RouteCandidate } from "./router.ts";

type FilesPreview = { source: "files"; id: string; files: { path: string; content: string }[] };
type RepositoryPreview = { source: "repository" | "atlas"; manifest: RepositoryContextManifest };
type PackagesPreview = { source: "packages"; id: string; packages: { project: string; manifest: RepositoryContextManifest }[] };
type OrchestratedPreview = { source: "orchestrated"; plan: OrchestrationPlan };
type MappedManifest = Omit<RepositoryContextManifest, "query">;

/** A source preview as the project and standalone Coding routes return it. */
export type CodingSourcePreview = FilesPreview | RepositoryPreview | PackagesPreview | OrchestratedPreview;

/**
 * What a preview selected, without the selected text. `id` is the preview ID
 * that an approved send repeats, so the manifest names exactly the selection
 * that approval covers. Excerpt text, attached file bodies, and profile
 * guidance stay in the preview.
 */
export type CodingSourceManifest =
  | { version: 1; source: "files"; id: string; files: { path: string; bytes: number; sha256: string }[] }
  | { version: 1; source: "repository"; id: string; manifest: RepositoryContextManifest }
  | { version: 1; source: "atlas"; id: string; manifest: MappedManifest }
  | { version: 1; source: "packages"; id: string; packages: { project: string; manifest: RepositoryContextManifest }[] }
  | { version: 1; source: "orchestrated"; id: string; orders: { scope: string; allowedDirectories?: string[]; manifest: MappedManifest; models: RouteCandidate[] }[];
      synthesis?: RouteCandidate[]; openRouter?: OpenRouterPreferences };

/** Copy the known manifest fields so a later preview field never reaches the clipboard by default. */
function repositoryManifest(manifest: RepositoryContextManifest): RepositoryContextManifest {
  const { trackedPaths, scannedFiles, fileBytes, selectedFiles, tokenBudget } = manifest.limitsReached;
  const { profile, index } = manifest;
  return {
    id: manifest.id, projects: [...manifest.projects], query: manifest.query, tokenBudget: manifest.tokenBudget,
    estimatedTokens: manifest.estimatedTokens, contextBytes: manifest.contextBytes, trackedPaths: manifest.trackedPaths,
    candidateFiles: manifest.candidateFiles, scannedFiles: manifest.scannedFiles, matchedFiles: manifest.matchedFiles,
    limitsReached: { trackedPaths, scannedFiles, fileBytes, selectedFiles, tokenBudget },
    files: manifest.files.map(({ path, startLine, endLine, sha256, reason }) => ({
      path, startLine, endLine, sha256, ...(reason === undefined ? {} : { reason }),
    })),
    ...(profile ? { profile: {
      version: profile.version, name: profile.name, id: profile.id,
      ...(profile.sharedProjects ? { sharedProjects: [...profile.sharedProjects] } : {}),
      ...(profile.exclude ? { exclude: [...profile.exclude] } : {}),
    } } : {}),
    ...(manifest.workspaceRevision === undefined ? {} : { workspaceRevision: manifest.workspaceRevision }),
    ...(index ? { index: { indexedFiles: index.indexedFiles, limited: index.limited, expandedFiles: index.expandedFiles } } : {}),
    ...(manifest.atlas ? { atlas: atlasManifest(manifest.atlas) } : {}),
  };
}

/** Names, hashes and counts only: nothing here is selected text. */
function atlasManifest(atlas: NonNullable<RepositoryContextManifest["atlas"]>): NonNullable<RepositoryContextManifest["atlas"]> {
  return {
    version: atlas.version, generation: atlas.generation, ...(atlas.importedAt === undefined ? {} : { importedAt: atlas.importedAt }),
    slots: atlas.slots.map(({ name, units, tokens }) => ({ name, units, tokens })), staleFiles: atlas.staleFiles,
    ...(atlas.untrackedFiles ? { untrackedFiles: atlas.untrackedFiles } : {}),
    map: { sha256: atlas.map.sha256, lines: atlas.map.lines },
    skills: atlas.skills.map(({ id, sha256, trial }) => ({ id, sha256, ...(trial ? { trial } : {}) })),
    ...(atlas.withheld?.length ? { withheld: [...atlas.withheld] } : {}),
    deferred: atlas.deferred.map(({ path, startLine, endLine, sha256 }) => ({ path, startLine, endLine, sha256 })), params: atlas.params,
  };
}

function mappedManifest(manifest: RepositoryContextManifest): MappedManifest {
  // A map uses the task itself as its query unless the operator supplies a separate search.
  const { query: _query, ...references } = repositoryManifest(manifest);
  return references;
}

export function codingSourceManifest(preview: CodingSourcePreview): CodingSourceManifest {
  if (preview.source === "files") {
    return { version: 1, source: "files", id: preview.id, files: preview.files.map(({ path, content }) => ({
      path, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"),
    })) };
  }
  if (preview.source === "packages") {
    return { version: 1, source: "packages", id: preview.id, packages: preview.packages.map(({ project, manifest }) => ({
      project, manifest: repositoryManifest(manifest),
    })) };
  }
  if (preview.source === "orchestrated") {
    const { id, orders, synthesis, openRouter } = preview.plan;
    const models = ({ choice, fallbacks }: OrchestrationPlan["orders"][number]["route"]) => [choice, ...fallbacks].map(
      ({ provider, model, thinkingLevel }) => ({ provider, model, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) }),
    );
    return { version: 1, source: "orchestrated", id, orders: orders.map(({ scope, allowedDirectories, manifest, route }) => ({
      scope, ...(allowedDirectories ? { allowedDirectories: [...allowedDirectories] } : {}), manifest: mappedManifest(manifest), models: models(route),
    })), ...(synthesis ? { synthesis: models(synthesis.route) } : {}), ...(openRouter ? { openRouter } : {}) };
  }
  if (preview.source === "atlas") return { version: 1, source: "atlas", id: preview.manifest.id, manifest: mappedManifest(preview.manifest) };
  return { version: 1, source: preview.source, id: preview.manifest.id, manifest: repositoryManifest(preview.manifest) };
}
