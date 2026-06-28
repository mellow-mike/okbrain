import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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
  test("explicit absolute wins", () => {
    const p = platform({ env: { OKB_BUNDLE: "/env" } });
    expect(resolveBundlePath("/abs", p)).toBe("/abs");
  });

  test("explicit relative resolves against cwd", () => {
    const p = platform({ cwd: "/work" });
    expect(resolveBundlePath("sub/brain", p)).toBe(join("/work", "sub", "brain"));
  });

  test("env override used when no explicit", () => {
    const p = platform({ env: { OKB_BUNDLE: "/env/brain" } });
    expect(resolveBundlePath(undefined, p)).toBe("/env/brain");
  });

  test("defaults to cwd", () => {
    const p = platform({ cwd: "/work" });
    expect(resolveBundlePath(undefined, p)).toBe("/work");
  });
});
