import { createHash } from "node:crypto";
import type { RepositoryContextManifest } from "./repository-context.ts";

type FilesPreview = { source: "files"; id: string; files: { path: string; content: string }[] };
type RepositoryPreview = { source: "repository"; manifest: RepositoryContextManifest };
type PackagesPreview = { source: "packages"; id: string; packages: { project: string; manifest: RepositoryContextManifest }[] };

/** A source preview as the project and standalone Coding routes return it. */
export type CodingSourcePreview = FilesPreview | RepositoryPreview | PackagesPreview;

/**
 * What a preview selected, without the selected text. `id` is the preview ID
 * that an approved send repeats, so the manifest names exactly the selection
 * that approval covers. Excerpt text, attached file bodies, and profile
 * guidance stay in the preview.
 */
export type CodingSourceManifest =
  | { version: 1; source: "files"; id: string; files: { path: string; bytes: number; sha256: string }[] }
  | { version: 1; source: "repository"; id: string; manifest: RepositoryContextManifest }
  | { version: 1; source: "packages"; id: string; packages: { project: string; manifest: RepositoryContextManifest }[] };

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
  };
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
  return { version: 1, source: "repository", id: preview.manifest.id, manifest: repositoryManifest(preview.manifest) };
}
