import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  InvalidIdError,
  idToAbsPath,
  idToRelPath,
  isReservedName,
  relPathToId,
  validateId,
} from "../src/core/okf/paths.ts";

describe("reserved names", () => {
  test("index.md and log.md are reserved", () => {
    expect(isReservedName("index.md")).toBe(true);
    expect(isReservedName("log.md")).toBe(true);
    expect(isReservedName("note.md")).toBe(false);
  });
});

describe("id ⇄ path", () => {
  test("idToRelPath joins segments with OS separator and adds .md", () => {
    expect(idToRelPath("foo")).toBe("foo.md");
    expect(idToRelPath("notes/foo")).toBe(join("notes", "foo.md"));
  });

  test("idToAbsPath roots the relative path", () => {
    expect(idToAbsPath("/root", "notes/foo")).toBe(join("/root", "notes", "foo.md"));
  });

  test("relPathToId strips .md and normalizes separators to /", () => {
    expect(relPathToId("notes/foo.md")).toBe("notes/foo");
    expect(relPathToId("notes\\foo.md")).toBe("notes/foo");
    expect(relPathToId("./foo.md")).toBe("foo");
  });
});

describe("validateId", () => {
  test("accepts safe ids", () => {
    expect(() => validateId("notes/foo")).not.toThrow();
  });

  test("rejects traversal, absolute, empty, and illegal chars", () => {
    for (const bad of ["", "/abs", "trail/", "a//b", "../x", "a/..", "a\\b"]) {
      expect(() => validateId(bad)).toThrow(InvalidIdError);
    }
  });
});
