// Learned aliases are laid over the derived search index. They are kept in
// learned state, so a rebuilt atlas gets them back on its next import.

import type { Database } from "bun:sqlite";

export type AliasGroups = ReadonlyMap<string, { path: string; name: string; terms: string[] }>;

/**
 * Set each unit's alias text. With `exhaustive`, aliases that are no longer
 * admitted are cleared too. A file whose aliases changed is marked for
 * re-embedding at the next import.
 */
export function applyAliases(db: Database, groups: AliasGroups, exhaustive = false): number {
  using find = db.prepare<{ id: number; file: number }, [string, string]>(
    "SELECT u.id, u.file FROM units u JOIN files f ON f.id = u.file WHERE f.path = ? AND u.name = ? ORDER BY u.ord LIMIT 1");
  using current = db.prepare<{ alias: string }, [number]>("SELECT alias FROM unit_text WHERE rowid = ?");
  using update = db.prepare<unknown, [string, number]>("UPDATE unit_text SET alias = ? WHERE rowid = ?");
  using stale = db.prepare<unknown, [number]>("UPDATE files SET vectors = NULL WHERE id = ?");
  const kept = new Set<number>();
  let changed = 0;
  const started = !db.inTransaction;
  if (started) db.exec("BEGIN IMMEDIATE");
  try {
    for (const { path, name, terms } of groups.values()) {
      const unit = find.get(path, name);
      if (!unit) continue;
      kept.add(unit.id);
      const text = terms.filter((term) => /^[\p{L}\p{N}_$]+$/u.test(term)).join(" ");
      if (current.get(unit.id)?.alias === text) continue;
      update.run(text, unit.id);
      stale.run(unit.file);
      changed++;
    }
    if (exhaustive) {
      using aliased = db.prepare<{ id: number }, []>("SELECT rowid AS id FROM unit_text WHERE alias != ''");
      using owner = db.prepare<{ file: number }, [number]>("SELECT file FROM units WHERE id = ?");
      for (const { id } of aliased.all()) {
        if (kept.has(id)) continue;
        update.run("", id);
        const file = owner.get(id)?.file;
        if (file !== undefined) stale.run(file);
        changed++;
      }
    }
    if (started) db.exec("COMMIT");
  } catch (error) {
    if (started && db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return changed;
}
