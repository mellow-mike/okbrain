// What an atlas-backed selection records beside the ordinary repository
// manifest. It names what was selected and why, never the selected text.

export interface AtlasManifest {
  version: 1;
  generation: number;
  importedAt?: string;
  /** Slots that contributed, with what each one spent. */
  slots: { name: string; units: number; tokens: number }[];
  /** Selected files whose bytes changed after the import. Their excerpts come from the current worktree. */
  staleFiles: number;
  /** The navigation map sent with the excerpts. */
  map: { sha256: string; lines: number };
  /** Skills and lessons delivered with this selection. `trial` marks one still being measured. */
  skills: { id: string; sha256: string; trial?: true }[];
  /** Skills that were eligible but withheld by this request's measurement draw. */
  withheld?: string[];
  /** Approved excerpts the model may request by path and line range. */
  deferred: { path: string; startLine: number; endLine: number; sha256: string }[];
  /** The version of the learned readout parameters used. */
  params: number;
}
