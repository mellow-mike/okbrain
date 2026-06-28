// Structured logger. Progress/diagnostics go to stderr so stdout stays clean for
// machine-readable op output (`--json`). Honors OKB_LOG_LEVEL and OKB_LOG_JSON.

export type Level = "debug" | "info" | "warn" | "error" | "silent";

const RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type Fields = Record<string, unknown>;

export interface LoggerOptions {
  level?: Level;
  json?: boolean;
  /** Sink for a finished line (newline already appended). Defaults to stderr. */
  write?: (line: string) => void;
}

function parseLevel(value: string | undefined, fallback: Level): Level {
  if (value && value in RANK) return value as Level;
  return fallback;
}

export class Logger {
  private readonly level: Level;
  private readonly json: boolean;
  private readonly sink: (line: string) => void;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? parseLevel(process.env.OKB_LOG_LEVEL, "info");
    this.json = opts.json ?? process.env.OKB_LOG_JSON === "1";
    this.sink = opts.write ?? ((line) => process.stderr.write(line));
  }

  private enabled(level: Level): boolean {
    return RANK[level] >= RANK[this.level];
  }

  private emit(level: Level, msg: string, fields?: Fields): void {
    if (!this.enabled(level)) return;
    if (this.json) {
      this.sink(
        JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) +
          "\n",
      );
      return;
    }
    let line = `${level}: ${msg}`;
    if (fields && Object.keys(fields).length > 0) {
      const pairs = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      line += ` ${pairs}`;
    }
    this.sink(line + "\n");
  }

  debug(msg: string, fields?: Fields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.emit("error", msg, fields);
  }
}

/** Process-wide default logger, configured from the environment. */
export const log = new Logger();
