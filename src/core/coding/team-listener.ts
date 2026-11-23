import { ProjectControlError, teamListenConfiguration } from "./project-control.ts";

export type TeamStartup = { port: number; publicOrigin: string | null };
export type TeamStatus = TeamStartup & { url: string };
export type TeamPreferences = { startup: TeamStartup | null; startupError: string | null };
type Handler = (req: Request, status: TeamStatus) => Promise<Response>;
type PreferenceStore = { get: () => TeamStartup | null; save: (value: TeamStartup | null) => void; ensure?: () => void };
const readError = "Could not read the saved Team workspace startup settings. Check the local coding project catalog.";

/** Project-token entry point. The independent listener has no owner or brain routes. */
export class CodingTeamListener {
  readonly #prefs?: PreferenceStore;
  #server?: Bun.Server<undefined>;
  #status: TeamStatus | null = null;
  #startupError: string | null = null;
  #changes: Promise<void> = Promise.resolve();
  #closing = false;
  #shutdown?: Promise<void>;

  constructor(prefs?: PreferenceStore) { this.#prefs = prefs; }

  get status() { return this.#status; }

  preferences(): TeamPreferences {
    try { return { startup: this.#saved(), startupError: this.#startupError }; }
    catch { return { startup: null, startupError: readError }; }
  }

  #saved(): TeamStartup | null {
    const value = this.#prefs?.get();
    return value ? teamListenConfiguration(value.port, value.publicOrigin) : null;
  }

  #save(startup: TeamStartup | null) {
    try {
      if (startup && !this.#prefs) throw new Error("Startup preferences are unavailable.");
      this.#prefs?.save(startup);
    } catch {
      throw new ProjectControlError("Could not save Team workspace startup settings. Check that local coding project data is writable.", 503);
    }
  }

  #serialize<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.#changes.then(work);
    this.#changes = result.then(() => undefined, () => undefined);
    return result;
  }

  #checkWrite(canWrite?: () => boolean) {
    if (this.#closing) throw new ProjectControlError("The Team workspace is shutting down.", 409);
    let allowed = false;
    try { allowed = canWrite === undefined || canWrite() === true; } catch { /* The selected brain is no longer writable. */ }
    if (!allowed) throw new ProjectControlError("Open a writable brain to change Team workspace settings.", 403);
  }

  change(body: Record<string, unknown>, handle: Handler, canWrite?: () => boolean): Promise<TeamStatus | null> {
    return this.#serialize(async () => {
      this.#checkWrite(canWrite);
      if (body.action === "stop") {
        try {
          if (this.#saved()) this.#save(null);
        } catch {
          this.#startupError = "The Team workspace stopped, but its startup setting could not be cleared. Disable startup before restarting okbrain.";
          throw new ProjectControlError(this.#startupError, 503);
        } finally { await this.#closeLive(); }
        this.#startupError = null;
        return null;
      }
      if (body.action !== "start") throw new ProjectControlError("Choose Start or Stop for the team workspace.");
      if (this.#server) throw new ProjectControlError("Stop the active team workspace before choosing a new address.", 409);
      if (body.startOnLaunch !== undefined && typeof body.startOnLaunch !== "boolean") {
        throw new ProjectControlError("Choose whether the Team workspace should start when okbrain opens.");
      }
      const automatic = body.startOnLaunch === true;
      const port = automatic ? body.port : body.port === undefined ? 6524 : body.port;
      const binding = teamListenConfiguration(port, body.publicOrigin, !automatic);
      const status = this.#listen(binding, handle);
      try {
        if (body.startOnLaunch !== undefined) this.#save(automatic ? binding : null);
      } catch (error) {
        await this.#closeLive();
        throw error;
      }
      this.#startupError = null;
      return status;
    });
  }

  changePreferences(body: Record<string, unknown>, handle: Handler, canWrite?: () => boolean): Promise<TeamPreferences> {
    return this.#serialize(() => {
      this.#checkWrite(canWrite);
      if (body.action === "enable") {
        const current = this.#status;
        if (!current || body.port !== current.port || body.publicOrigin !== current.publicOrigin) {
          throw new ProjectControlError("The active Team workspace address changed. Refresh its status before enabling startup.", 409);
        }
        this.#save({ port: current.port, publicOrigin: current.publicOrigin });
      } else if (body.action === "disable") {
        this.#save(null);
      } else if (body.action === "retry") {
        if (this.#server) throw new ProjectControlError("Stop the active Team workspace before retrying startup.", 409);
        return this.#restore(handle, canWrite);
      } else throw new ProjectControlError("Choose Enable, Disable, or Retry for Team workspace startup.");
      this.#startupError = null;
      return this.preferences();
    });
  }

  restore(handle: Handler, canWrite?: () => boolean): Promise<TeamPreferences> {
    return this.#serialize(() => this.#restore(handle, canWrite));
  }

  #restore(handle: Handler, canWrite?: () => boolean): TeamPreferences {
    if (this.#closing) return { startup: null, startupError: null };
    let startup: TeamStartup | null;
    try { startup = this.#saved(); }
    catch {
      this.#startupError = readError;
      return { startup: null, startupError: this.#startupError };
    }
    try {
      if (startup && !this.#server) {
        this.#checkWrite(canWrite);
        this.#listen(startup, handle);
      }
      this.#startupError = null;
    } catch (error) {
      this.#startupError = error instanceof ProjectControlError ? error.message
        : "Could not start the saved Team workspace. Check its local address and retry startup.";
    }
    return { startup, startupError: this.#startupError };
  }

  #listen({ port, publicOrigin }: TeamStartup, handle: Handler): TeamStatus {
    this.#prefs?.ensure?.();
    try {
      const server: Bun.Server<undefined> = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => {
          server.timeout(req, 65);
          return handle(req, status);
        },
      });
      const status: TeamStatus = Object.freeze({ url: `http://127.0.0.1:${server.port}/`, port: server.port!, publicOrigin });
      this.#server = server;
      this.#status = status;
      return status;
    } catch (error) {
      if ((error as { code?: string }).code === "EADDRINUSE")
        throw new ProjectControlError(`Local TCP port ${port} is already in use. Free the port and retry, or choose another address.`, 409);
      throw error;
    }
  }

  async #closeLive() {
    const server = this.#server;
    this.#server = undefined;
    this.#status = null;
    await server?.stop(true);
  }

  /** Shut down the process listener and retain the owner's explicit startup preference. */
  stop(): Promise<void> {
    this.#closing = true;
    return this.#shutdown ??= this.#serialize(() => this.#closeLive());
  }
}
