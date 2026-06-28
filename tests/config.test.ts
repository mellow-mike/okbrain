import { describe, expect, test } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
import {
  APP_NAME,
  configDir,
  dataDir,
  resolveBundlePath,
  type Platform,
} from "../src/core/config.ts";

function platform(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    env: {},
    home: "/home/u",
    cwd: "/work",
    ...over,
  };
}

describe("configDir / dataDir", () => {
  test("linux uses XDG defaults", () => {
    const p = platform({ os: "linux" });
    expect(configDir(p)).toBe(join("/home/u", ".config", APP_NAME));
    expect(dataDir(p)).toBe(join("/home/u", ".local", "share", APP_NAME));
  });

  test("linux honors XDG overrides", () => {
    const p = platform({
      env: { XDG_CONFIG_HOME: "/xc", XDG_DATA_HOME: "/xd" },
    });
    expect(configDir(p)).toBe(join("/xc", APP_NAME));
    expect(dataDir(p)).toBe(join("/xd", APP_NAME));
  });

  test("macOS resolves XDG-style under home", () => {
    const p = platform({ os: "darwin" });
    expect(configDir(p)).toBe(join("/home/u", ".config", APP_NAME));
    expect(dataDir(p)).toBe(join("/home/u", ".local", "share", APP_NAME));
  });

  test("windows uses APPDATA / LOCALAPPDATA", () => {
    const p = platform({
      os: "win32",
      home: "C:\\Users\\u",
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    });
    expect(configDir(p)).toBe(join("C:\\Users\\u\\AppData\\Roaming", APP_NAME));
    expect(dataDir(p)).toBe(join("C:\\Users\\u\\AppData\\Local", APP_NAME));
  });

  test("windows falls back when env unset", () => {
    const p = platform({ os: "win32", home: "C:\\Users\\u", env: {} });
    expect(configDir(p)).toBe(join("C:\\Users\\u", "AppData", "Roaming", APP_NAME));
    expect(dataDir(p)).toBe(join("C:\\Users\\u", "AppData", "Local", APP_NAME));
  });
});

describe("resolveBundlePath", () => {
  // Build expectations through node:path so they're correct on every OS
  // (on Windows `/work` resolves drive-anchored to e.g. `D:\work`).
  const cwd = resolve("/work");
  const base = (over: Partial<Platform> = {}) => platform({ cwd, ...over });

  test("explicit wins over env and cwd", () => {
    const p = base({ env: { OKB_BUNDLE: resolve("/env") } });
    expect(resolveBundlePath(resolve("/abs"), p)).toBe(resolve("/abs"));
  });

  test("explicit relative resolves against cwd", () => {
    expect(resolveBundlePath(join("sub", "brain"), base())).toBe(
      resolve(cwd, "sub", "brain"),
    );
  });

  test("env override used when no explicit", () => {
    const p = base({ env: { OKB_BUNDLE: resolve("/env", "brain") } });
    expect(resolveBundlePath(undefined, p)).toBe(resolve("/env", "brain"));
  });

  test("defaults to cwd", () => {
    expect(resolveBundlePath(undefined, base())).toBe(cwd);
  });

  test("result is always absolute", () => {
    expect(isAbsolute(resolveBundlePath("rel", base()))).toBe(true);
  });
});
