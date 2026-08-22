/** Shared configuration for the stage 0 measurement tools. */
export const STAGE0 = {
  /** gowa's REST base URL, as published by deploy/stage0/docker-compose.yml. */
  gowaBaseUrl: process.env.GOWA_URL ?? "http://127.0.0.1:3000",
  /** gowa's internal broadcast WebSocket. */
  gowaWsUrl: process.env.GOWA_WS ?? "ws://127.0.0.1:3000/ws",
  /** Port the webhook sink listens on; must match WHATSAPP_WEBHOOK in .env. */
  sinkPort: Number(process.env.SINK_PORT ?? 3999),
  /** Shared secret gowa signs webhook payloads with. */
  webhookSecret: process.env.WEBHOOK_SECRET ?? "stage0-secret",
  /** Compose container name, for docker stats and network manipulation. */
  container: process.env.GOWA_CONTAINER ?? "bunwa-stage0-gowa-1",
  /** Where JSONL observations are appended. */
  dataDir: new URL("../../../deploy/stage0/data/", import.meta.url).pathname,
} as const;

/** Append one observation to a JSONL file, creating it if absent. */
export async function record(file: string, row: Record<string, unknown>): Promise<void> {
  const path = STAGE0.dataDir + file;
  const line = JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n";
  const existing = Bun.file(path);
  const prior = (await existing.exists()) ? await existing.text() : "";
  await Bun.write(path, prior + line);
}

/** ANSI helpers — the harness is read at a glance, so colour earns its place. */
export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** HH:MM:SS.mmm, for correlating observations across the three tools. */
export function stamp(d = new Date()): string {
  return d.toISOString().slice(11, 23);
}
