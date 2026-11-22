import { ProjectControlError } from "./project-control.ts";

export type TeamStatus = { url: string; port: number; publicOrigin: string | null };
type Handler = (req: Request, status: TeamStatus) => Promise<Response>;

/** Project-token entry point. The independent listener has no owner or brain routes. */
export class CodingTeamListener {
  #server?: Bun.Server<undefined>;
  #status: TeamStatus | null = null;

  get status() { return this.#status; }

  async change(body: Record<string, unknown>, handle: Handler) {
    if (body.action === "stop") {
      await this.stop();
      return null;
    }
    if (body.action !== "start") throw new ProjectControlError("Choose Start or Stop for the team workspace.");
    if (this.#server) throw new ProjectControlError("Stop the active team workspace before choosing a new address.", 409);
    const port = body.port === undefined ? 6524 : body.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new ProjectControlError("Enter a local TCP port from 0 to 65535.");
    const publicOrigin = this.#origin(body.publicOrigin);
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => {
          server.timeout(req, 65);
          return handle(req, this.#status!);
        },
      });
      this.#server = server;
      this.#status = { url: `http://127.0.0.1:${server.port}/`, port: server.port!, publicOrigin };
      return this.#status;
    } catch (error) {
      if ((error as { code?: string }).code === "EADDRINUSE")
        throw new ProjectControlError("That local TCP port is already in use.", 409);
      throw error;
    }
  }

  #origin(value: unknown): string | null {
    if (value === undefined || value === "") return null;
    let origin: URL;
    try {
      if (typeof value !== "string" || value.length > 256) throw new Error();
      origin = new URL(value);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
        throw new Error();
    } catch {
      throw new ProjectControlError("Enter an HTTPS origin without a path, credentials, query, or fragment.");
    }
    return origin.origin;
  }

  async stop() {
    const server = this.#server;
    this.#server = undefined;
    this.#status = null;
    await server?.stop(true);
  }
}
