/**
 * Stage 0 status board.
 *
 * One-shot summary of the harness: what is running, what gowa thinks the
 * devices are doing, what each probe has captured so far, and which of the
 * open questions in docs/12 are still unanswered.
 *
 *   bun run stage0:status
 */
import { STAGE0, c } from "./config";

const ok = (s: string) => c.green(`● ${s}`);
const no = (s: string) => c.red(`○ ${s}`);
const warn = (s: string) => c.yellow(`◐ ${s}`);

/** Run a command, returning trimmed stdout or "" on any failure. */
async function sh(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : "";
  } catch {
    return "";
  }
}

/** Count lines in a JSONL file, and tally a field across them. */
async function jsonl(name: string, field?: string): Promise<{ count: number; tally: Map<string, number> }> {
  const f = Bun.file(STAGE0.dataDir + name);
  const tally = new Map<string, number>();
  if (!(await f.exists())) return { count: 0, tally };
  const lines = (await f.text()).split("\n").filter(Boolean);
  if (field) {
    for (const line of lines) {
      try {
        const v = String((JSON.parse(line) as Record<string, unknown>)[field] ?? "?");
        tally.set(v, (tally.get(v) ?? 0) + 1);
      } catch { /* skip malformed */ }
    }
  }
  return { count: lines.length, tally };
}

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

console.log(c.bold("\n  stage 0 status\n"));

// ── processes ────────────────────────────────────────────────────────────────
const container = await sh(["docker", "ps", "--filter", `name=${STAGE0.container}`, "--format", "{{.Status}}"]);
const procs = await sh(["pgrep", "-af", "stage0/(sink|wstap|measure|drop).ts"]);
const running = (n: string) => procs.includes(`stage0/${n}.ts`);

console.log(c.bold("  processes"));
console.log(`    ${container ? ok(`gowa        ${container}`) : no("gowa        not running  → bun run stage0:up")}`);
console.log(`    ${running("sink") ? ok("sink        capturing webhooks") : no("sink        not running  → bun run stage0:sink")}`);
console.log(`    ${running("wstap") ? ok("ws tap      capturing broadcasts") : no("ws tap      not running  → bun run stage0:ws")}`);
console.log(`    ${running("measure") ? ok("measure     sampling") : no("measure     not running  → bun run stage0:measure")}`);

// ── devices ──────────────────────────────────────────────────────────────────
console.log(c.bold("\n  devices"));
let paired = 0;
if (await reachable(`${STAGE0.gowaBaseUrl}/health`)) {
  const res = await fetch(`${STAGE0.gowaBaseUrl}/devices`);
  const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const list = body.results ?? [];
  if (list.length === 0) {
    console.log(warn("    no device slots — POST /devices to create one"));
  }
  for (const d of list) {
    const id = String(d["id"]);
    // /devices list `state` is unreliable; only status is trustworthy (docs/12).
    const s = (await (await fetch(`${STAGE0.gowaBaseUrl}/devices/${encodeURIComponent(id)}/status`)).json()) as {
      results?: { is_connected?: boolean; is_logged_in?: boolean };
    };
    const conn = s.results?.is_connected === true;
    const login = s.results?.is_logged_in === true;
    if (conn && login) paired++;
    const label = conn && login ? ok("connected") : conn ? warn("pairing  ") : no("offline  ");
    console.log(`    ${label}  ${c.bold(id.padEnd(16))} ${c.dim(`is_connected=${conn}  is_logged_in=${login}  list.state=${String(d["state"])}`)}`);
  }
} else {
  console.log(no("    gowa unreachable"));
}

// ── captures ─────────────────────────────────────────────────────────────────
const hooks = await jsonl("webhooks.jsonl", "event");
const ws = await jsonl("ws.jsonl", "code");
const metrics = await jsonl("metrics.jsonl");
const drops = await jsonl("drop.jsonl");

console.log(c.bold("\n  captured"));
const line = (n: number, what: string) => `    ${String(n).padStart(5)}  ${what}`;
console.log(line(hooks.count, "webhooks    webhooks.jsonl"));
for (const [k, v] of [...hooks.tally].sort((a, b) => b[1] - a[1])) console.log(c.dim(`             ${String(v).padStart(4)} × ${k}`));
console.log(line(ws.count, "broadcasts  ws.jsonl"));
for (const [k, v] of [...ws.tally].sort((a, b) => b[1] - a[1])) console.log(c.dim(`             ${String(v).padStart(4)} × ${k}`));
console.log(line(metrics.count, "samples     metrics.jsonl"));
console.log(line(drops.count, "drop tests  drop.jsonl"));

// ── open questions ───────────────────────────────────────────────────────────
const lifecycleSeen = [...hooks.tally.keys()].some((k) => /device|session|logout|connect|pair|qr/i.test(k));
const q: Array<[boolean, string]> = [
  [paired > 0, "a device is paired"],
  [metrics.count > 3 && paired > 0, "memory sampled with a device connected"],
  [drops.count > 0, "socket-drop latency measured"],
  [hooks.count > 0, "at least one webhook received"],
  [hooks.count > 0 && !lifecycleSeen, "confirmed no lifecycle event reaches a webhook"],
  [ws.tally.has("DEVICE_LOGGED_OUT"), "remote logout observed on /ws"],
  [[...hooks.tally.keys()].includes("call.offer"), "incoming call observed, unanswered"],
];
console.log(c.bold("\n  open questions"));
for (const [done, label] of q) console.log(`    ${done ? c.green("✓") : c.dim("·")} ${done ? label : c.dim(label)}`);

if (paired === 0) {
  console.log(c.bold(c.yellow("\n  next: pair a device")));
  console.log(c.dim(`    open ${STAGE0.gowaBaseUrl} in a browser, or:`));
  console.log(c.dim(`    curl -s ${STAGE0.gowaBaseUrl}/devices/stage0-a/login | jq -r .results.qr_link`));
}
console.log();
