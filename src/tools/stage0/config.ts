/** Shared configuration and helpers for the stage 0 measurement tools. */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parse an integer from configuration, failing loudly.
 *
 * `Number(x) || fallback` silently swallows a typo: `SINK_PORT=300O` becomes
 * NaN, falls back, and the sink then listens somewhere the operator did not
 * intend while reporting success.
 */
export function intOrThrow(raw: string | undefined, fallback: number, name: string, min = 1, max = 65535): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got ${JSON.stringify(raw)}`);
  }
  return n;
}

export const STAGE0 = {
  /** gowa's REST base URL, as published by deploy/stage0/docker-compose.yml. */
  gowaBaseUrl: process.env.GOWA_URL ?? "http://127.0.0.1:3000",
  /** gowa's internal broadcast WebSocket. */
  gowaWsUrl: process.env.GOWA_WS ?? "ws://127.0.0.1:3000/ws",
  /** Port the webhook sink listens on; must match WHATSAPP_WEBHOOK in .env. */
  sinkPort: intOrThrow(process.env.SINK_PORT, 3999, "SINK_PORT"),
  /** Shared secret gowa signs webhook payloads with. */
  webhookSecret: process.env.WEBHOOK_SECRET ?? "stage0-secret",
  /** Compose container name, for docker stats and network manipulation. */
  container: process.env.GOWA_CONTAINER ?? "bunwa-stage0-gowa-1",
  /**
   * Where JSONL observations are appended.
   *
   * `fileURLToPath` rather than `URL.pathname`: the latter keeps percent
   * encoding, so a checkout under a path containing a space or a `#` resolves
   * to a directory that does not exist.
   */
  dataDir: fileURLToPath(new URL("../../../deploy/stage0/data/", import.meta.url)),
} as const;

/**
 * Serialise appends per file.
 *
 * The sink, the tap and the sampler all write concurrently. A read-modify-write
 * loses whichever row lost the race, silently, in exactly the files the design
 * conclusions are drawn from — so appends are both atomic and queued per path.
 */
const writeQueues = new Map<string, Promise<void>>();

/** Append one observation to a JSONL file, creating it if absent. */
export async function record(file: string, row: Record<string, unknown>): Promise<void> {
  const path = STAGE0.dataDir + file;
  const line = JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n";
  const prior = writeQueues.get(path) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined) // one failed write must not poison the queue
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    });
  writeQueues.set(path, next);
  return next;
}

/**
 * The address host-side servers must bind so that gowa, inside its container,
 * can reach them via `host.docker.internal`.
 *
 * Binding `0.0.0.0` would work but exposes an unauthenticated sink to every
 * host on the network, which can then inject rows into the measurement data.
 * The docker bridge gateway is the narrowest address that still works.
 */
export async function containerReachableBindAddress(): Promise<string> {
  if (process.env.SINK_BIND) return process.env.SINK_BIND;
  try {
    const p = Bun.spawn(
      ["docker", "network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = (await new Response(p.stdout).text()).trim();
    if ((await p.exited) === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch {
    /* fall through */
  }
  console.warn(c.yellow("  could not resolve the docker bridge gateway; binding 127.0.0.1 (gowa will not reach it)"));
  return "127.0.0.1";
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

/** HH:MM:SS.mmm, for correlating observations across the tools. */
export function stamp(d = new Date()): string {
  return d.toISOString().slice(11, 23);
}

/**
 * Mask a phone number or JID for on-disk records: 628…95@s.whatsapp.net.
 *
 * Seven digits is the threshold, not nine: a national-format number written
 * without a country code is still a real person's number.
 */
export function maskPhone(value: string): string {
  return value.replace(/(\d{2})\d{3,}(\d{2})/g, "$1…$2");
}

/**
 * Mask every string in a structure, leaving numbers, booleans and keys alone.
 *
 * Masking a serialised JSON blob instead would rewrite unquoted number
 * literals — a millisecond timestamp becomes `17…01` — and the document no
 * longer parses. Walking the parsed value keeps the shape intact.
 */
/**
 * Free-text fields whose content the harness never needs.
 *
 * Masking identifiers is not enough: the message body is the most sensitive
 * part of an inbound capture, and it belongs to a third party. The harness
 * studies payload *shape* — which fields appear, how they nest, whether a
 * media field is an object or a bare string — so the text itself can be
 * replaced by its length and nothing is lost.
 */
const CONTENT_FIELDS = new Set(["body", "caption", "text", "message", "conversation", "push_name", "from_name", "sender_display_name"]);

export function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return maskPhone(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        CONTENT_FIELDS.has(k) && typeof v === "string" ? `<redacted ${v.length} chars>` : maskDeep(v),
      ]),
    );
  }
  return value;
}
