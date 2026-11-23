import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_ACTOR } from "../version.ts";
import { listConcepts } from "./bundle.ts";
import { writeConcept } from "./write.ts";

const starters = [
  {
    name: "personal", title: "Personal knowledge",
    description: "Keep ideas, sources, and open questions you want to revisit.",
    tags: ["idea", "reading", "question"],
    prompts: [
      "Use `note` with `idea` for a thought you can put in your own words.",
      "Use `source` with `reading` for a book, article, or talk. Record its URL and what you took from it.",
      "Use `note` with `question` for something you want to investigate. Link notes that help answer it.",
    ],
  },
  {
    name: "projects", title: "Projects and decisions",
    description: "Track project outcomes, decisions, and lessons worth keeping.",
    tags: ["project", "decision", "lesson"],
    prompts: [
      "Use `project` with `project` for the outcome, next step, and open questions.",
      "Use `decision` with `decision` to record what you chose, when, and why. Link it to its project.",
      "Use `note` with `lesson` to capture what you would repeat or change next time.",
    ],
  },
];

export const brainStarterCatalog = starters.map(({ name, title, description, tags }) => ({ name, title, description, tags }));
export type BrainStarter = (typeof starters)[number];

export function findBrainStarter(name: string): BrainStarter | undefined {
  return starters.find((starter) => starter.name === name);
}

/** Apply a starter only to a brain that has no existing notes. */
export async function createBrainStarter(root: string, starter: BrainStarter): Promise<{ id: string; created: boolean }> {
  const id = "start-here";
  if ((await listConcepts(root)).length) return { id, created: false };
  // The canonical writer refreshes these files as part of saving the guide.
  for (const name of ["index.md", "log.md"]) {
    const file = await lstat(join(root, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (file && !file.isFile()) return { id, created: false };
  }
  return writeConcept(root, {
    id,
    type: "guide",
    title: `${starter.title} starter guide`,
    description: starter.description,
    body: `${starter.description}\n\n## What to save\n\n${starter.prompts.map((item) => `- ${item}`).join("\n")}\n\nAdapt the types and tags as your brain grows. You can edit or remove this guide like any other note.\n`,
    tags: starter.tags,
    actor: TOOL_ACTOR,
    extra: { starter_template: starter.name },
  }, { createOnly: true });
}
