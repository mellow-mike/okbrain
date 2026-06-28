import { describe, expect, test } from "bun:test";
import { Logger } from "../src/core/log.ts";

function capture() {
  const lines: string[] = [];
  return { lines, write: (l: string) => lines.push(l) };
}

describe("Logger", () => {
  test("filters below the configured level", () => {
    const c = capture();
    const log = new Logger({ level: "warn", write: c.write });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(c.lines).toEqual(["warn: w\n", "error: e\n"]);
  });

  test("silent suppresses everything", () => {
    const c = capture();
    const log = new Logger({ level: "silent", write: c.write });
    log.error("nope");
    expect(c.lines).toEqual([]);
  });

  test("text format appends fields", () => {
    const c = capture();
    const log = new Logger({ level: "info", write: c.write });
    log.info("indexed", { count: 3, dir: "notes" });
    expect(c.lines[0]).toBe("info: indexed count=3 dir=notes\n");
  });

  test("json format emits structured lines", () => {
    const c = capture();
    const log = new Logger({ level: "info", json: true, write: c.write });
    log.warn("slow", { ms: 42 });
    const obj = JSON.parse(c.lines[0]!);
    expect(obj.level).toBe("warn");
    expect(obj.msg).toBe("slow");
    expect(obj.ms).toBe(42);
    expect(typeof obj.ts).toBe("string");
  });
});
