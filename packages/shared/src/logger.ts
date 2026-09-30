import pino, { type Logger } from "pino";

export type { Logger };

let root: Logger | undefined;

export function createLogger(name: string, level?: string): Logger {
  if (!root) {
    root = pino({
      level: level ?? process.env.LOG_LEVEL ?? "info",
      base: undefined,
      redact: {
        paths: [
          "seed",
          "*.seed",
          "secret",
          "*.secret",
          "privateKey",
          "*.privateKey",
          "apiKey",
          "*.apiKey",
        ],
        censor: "[REDACTED]",
      },
    });
  }
  return root.child({ name });
}
