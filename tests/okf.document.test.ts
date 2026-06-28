import { describe, expect, test } from "bun:test";
import {
  OkfParseError,
  parse,
  serialize,
  validate,
} from "../src/core/okf/document.ts";

describe("parse", () => {
  test("splits frontmatter and body", () => {
    const doc = parse("---\ntype: note\ntitle: Hi\n---\n\nBody text\n");
    expect(doc.frontmatter).toEqual({ type: "note", title: "Hi" });
    expect(doc.body).toBe("\nBody text\n");
  });

  test("missing frontmatter → empty map, whole text is body", () => {
    const doc = parse("# Heading\n\nplain markdown\n");
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe("# Heading\n\nplain markdown\n");
  });

  test("empty frontmatter block", () => {
    const doc = parse("---\n---\nbody\n");
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe("body\n");
  });

  test("frontmatter with no body and no trailing newline", () => {
    const doc = parse("---\ntype: note\n---");
    expect(doc.frontmatter).toEqual({ type: "note" });
    expect(doc.body).toBe("");
  });

  test("accepts CRLF and strips BOM", () => {
    const doc = parse("﻿---\r\ntype: note\r\n---\r\nbody\r\n");
    expect(doc.frontmatter).toEqual({ type: "note" });
    expect(doc.body).toBe("body\n");
  });

  test("malformed YAML throws OkfParseError", () => {
    expect(() => parse("---\nkey: : :\n---\n")).toThrow(OkfParseError);
  });

  test("non-mapping frontmatter throws", () => {
    expect(() => parse("---\n- a\n- b\n---\n")).toThrow(OkfParseError);
  });

  test("preserves unknown keys", () => {
    const doc = parse("---\ntype: note\nweird_key: 7\nnested:\n  k: v\n---\nx");
    expect(doc.frontmatter.weird_key).toBe(7);
    expect(doc.frontmatter.nested).toEqual({ k: "v" });
  });
});

describe("serialize", () => {
  test("emits block-style frontmatter", () => {
    const out = serialize({
      frontmatter: { type: "note", tags: ["a", "b"] },
      body: "\nhello\n",
    });
    expect(out).toBe("---\ntype: note\ntags:\n  - a\n  - b\n---\n\nhello\n");
  });

  test("empty frontmatter → body only", () => {
    expect(serialize({ frontmatter: {}, body: "just body\n" })).toBe("just body\n");
  });

  test("semantic round-trip is idempotent", () => {
    const raw = "---\ntype: ref\ntitle: T\ndescription: D\ntags:\n  - x\n---\n\nBody\nmore\n";
    const once = serialize(parse(raw));
    const twice = serialize(parse(once));
    expect(once).toBe(raw);
    expect(twice).toBe(once);
  });

  test("unknown keys survive a round-trip", () => {
    const raw = "---\ntype: note\ncustom: keep-me\n---\nbody";
    expect(parse(serialize(parse(raw))).frontmatter.custom).toBe("keep-me");
  });
});

describe("validate", () => {
  test("requires a non-empty string type", () => {
    expect(validate({ frontmatter: { type: "note" }, body: "" }).ok).toBe(true);
    expect(validate({ frontmatter: {}, body: "" }).ok).toBe(false);
    expect(validate({ frontmatter: { type: "" }, body: "" }).ok).toBe(false);
    expect(validate({ frontmatter: { type: 5 }, body: "" }).ok).toBe(false);
  });
});
