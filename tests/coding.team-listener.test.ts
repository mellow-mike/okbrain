import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codingProjectCatalogPath, CodingProjectControl, ProjectControlError, readCodingTeamStartup, readCodingTeamStartupPort,
} from "../src/core/coding/project-control.ts";
import { CodingTeamListener, type TeamStartup } from "../src/core/coding/team-listener.ts";

const handle = async () => new Response("team");

test("a failed Team preference save releases the new fixed listener", async () => {
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const port = reserve.port!;
  await reserve.stop(true);
  let saves = 0;
  const team = new CodingTeamListener({
    get: () => null,
    save: () => { saves++; throw new Error("private persistence failure"); },
  });
  try {
    await expect(team.change({ action: "start", port, startOnLaunch: true }, handle)).rejects.toThrow("Could not save Team workspace startup settings");
    expect(saves).toBe(1);
    expect(team.status).toBeNull();
    expect(team.preferences()).toEqual({ startup: null, startupError: null });
    const reusable = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
    await reusable.stop(true);
  } finally { await team.stop(); }
});

test("Team restore respects writable scope at execution and shutdown cancels queued binds", async () => {
  const saved = { port: 6524, publicOrigin: "https://team.example" };
  const team = new CodingTeamListener({ get: () => saved, save: () => { throw new Error("unexpected save"); } });
  let writable = true;
  try {
    const restore = team.restore(handle, () => writable);
    writable = false;
    expect(await restore).toEqual({ startup: saved, startupError: expect.stringContaining("writable brain") });
    expect(team.status).toBeNull();
    writable = true;
    const queued = team.change({ action: "start", port: 0 }, handle, () => writable);
    const closed = team.stop();
    await expect(queued).rejects.toThrow("shutting down");
    await closed;
    expect(team.status).toBeNull();
    expect(team.preferences().startup).toEqual(saved);
  } finally { await team.stop(); }
});

test("Team restore does not bind without the project catalog and Stop closes live access on a save failure", async () => {
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const port = reserve.port!;
  await reserve.stop(true);
  const binding = { port, publicOrigin: "https://team.example" };
  let saved: TeamStartup | null = binding;
  let available = false;
  const team = new CodingTeamListener({
    get: () => saved,
    save: (value) => { if (!available) throw new Error("catalog unavailable"); saved = value; },
    ensure: () => { if (!available) throw new ProjectControlError("Coding projects are already open in another okbrain server.", 409); },
  });
  try {
    expect(await team.restore(handle)).toEqual({ startup: binding, startupError: expect.stringContaining("another okbrain server") });
    expect(team.status).toBeNull();
    available = true;
    expect(await team.changePreferences({ action: "retry" }, handle)).toEqual({ startup: binding, startupError: null });
    expect(team.status?.port).toBe(port);
    available = false;
    await expect(team.change({ action: "stop" }, handle)).rejects.toThrow("startup setting could not be cleared");
    expect(team.status).toBeNull();
    expect(team.preferences()).toEqual({ startup: binding, startupError: expect.stringContaining("Disable startup") });
    const reusable = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
    await reusable.stop(true);
  } finally { await team.stop(); }
});

test("a read-only startup lookup does not create the catalog and returns the saved fixed address", async () => {
  const base = await mkdtemp(join(tmpdir(), "okb-team-startup-"));
  const stateDir = join(base, "coding");
  let catalog: CodingProjectControl | undefined;
  try {
    await mkdir(stateDir);
    expect(readCodingTeamStartup(stateDir)).toBeNull();
    expect(readCodingTeamStartupPort(stateDir)).toBeNull();
    await expect(access(codingProjectCatalogPath(stateDir))).rejects.toThrow();
    catalog = new CodingProjectControl({ stateDir });
    expect(catalog.getTeamStartup()).toBeNull();
    const saved: TeamStartup = { port: 6524, publicOrigin: "HTTPS://Team.Example:443/" };
    catalog.saveTeamStartup(saved);
    expect(readCodingTeamStartup(stateDir)).toEqual({ port: saved.port, publicOrigin: "https://team.example" });
    expect(readCodingTeamStartupPort(stateDir)).toBe(saved.port);
    expect(() => catalog!.saveTeamStartup({ port: 0, publicOrigin: null })).toThrow("fixed local TCP port");
    expect(() => catalog!.saveTeamStartup({ port: saved.port, publicOrigin: "https://team.example/." })).toThrow("HTTPS origin");
    expect(catalog.getTeamStartup()?.port).toBe(saved.port);
  } finally {
    await catalog?.close();
    await rm(base, { recursive: true, force: true });
  }
});
