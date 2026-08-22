/**
 * Stage 0 resource measurement.
 *
 * Samples the gowa container's memory and file-descriptor use alongside the
 * number of connected devices, so that per-device cost can be derived. That
 * figure sets the engine pool size in docs/03 and the density ceiling in the
 * single-container topology (docs/11); it is currently a guess and must not
 * stay one.
 *
 *   bun run src/tools/stage0/measure.ts [--interval 10] [--samples 0]
 */
import { STAGE0, record, c, stamp } from "./config";

interface Sample {
  devices: number;
  connected: number;
  memBytes: number;
  fds: number;
  pids: number;
}

/** Read one line of `docker stats`, which reports memory and pid count. */
async function dockerStats(): Promise<{ memBytes: number; pids: number }> {
  const proc = Bun.spawn(
    ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}|{{.PIDs}}", STAGE0.container],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if (!out) return { memBytes: 0, pids: 0 };
  const [mem = "", pids = "0"] = out.split("|");
  const [used = "0B"] = mem.split(" / ");
  return { memBytes: parseSize(used), pids: Number(pids) || 0 };
}

/** "123.4MiB" → bytes. docker stats uses binary units. */
function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(s.trim());
  if (!m?.[1]) return 0;
  const scale: Record<string, number> = {
    b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  };
  return Number(m[1]) * (scale[(m[2] ?? "B").toLowerCase()] ?? 1);
}

/** Count open file descriptors inside the container. */
async function openFds(): Promise<number> {
  const proc = Bun.spawn(
    ["docker", "exec", STAGE0.container, "sh", "-c", "ls /proc/*/fd 2>/dev/null | wc -l"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return Number((await new Response(proc.stdout).text()).trim()) || 0;
}

/**
 * Ask gowa how many device slots exist and how many are actually usable.
 *
 * The `/devices` list `state` field is not trustworthy — it has reported
 * "connected" for an unpaired slot and "logged_in" for a live one, and does not
 * agree with the status endpoint (docs/12). Only `/devices/{id}/status` is
 * authoritative, so each slot is checked individually.
 */
async function deviceCounts(): Promise<{ devices: number; connected: number }> {
  try {
    const res = await fetch(`${STAGE0.gowaBaseUrl}/devices`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const list = body.results ?? [];
    const states = await Promise.all(
      list.map(async (d) => {
        try {
          const r = await fetch(`${STAGE0.gowaBaseUrl}/devices/${encodeURIComponent(String(d["id"]))}/status`, {
            signal: AbortSignal.timeout(5000),
          });
          const s = (await r.json()) as { results?: { is_connected?: boolean; is_logged_in?: boolean } };
          return s.results?.is_connected === true && s.results?.is_logged_in === true;
        } catch {
          return false;
        }
      }),
    );
    return { devices: list.length, connected: states.filter(Boolean).length };
  } catch {
    return { devices: -1, connected: -1 };
  }
}

async function sample(): Promise<Sample> {
  const [{ memBytes, pids }, fds, counts] = await Promise.all([dockerStats(), openFds(), deviceCounts()]);
  return { ...counts, memBytes, fds, pids };
}

const args = Bun.argv.slice(2);
const intervalSec = Number(args[args.indexOf("--interval") + 1]) || 10;
const maxSamples = Number(args[args.indexOf("--samples") + 1]) || 0;

const mib = (b: number) => (b / 1024 ** 2).toFixed(1).padStart(7);

console.log(c.bold(`stage0 measurement — every ${intervalSec}s${maxSamples ? `, ${maxSamples} samples` : ", until Ctrl-C"}`));
console.log(c.dim("  writing metrics.jsonl\n"));
console.log(c.dim("  time         devices  conn   mem MiB    fds  pids   MiB/device"));

const baseline: Sample = await sample();
let n = 0;

/** Marginal cost per connected device, against the first sample as a baseline. */
function perDevice(s: Sample): string {
  if (s.connected <= 0) return c.dim("     —");
  const delta = (s.memBytes - baseline.memBytes) / 1024 ** 2;
  const idle = baseline.connected === 0 ? s.connected : s.connected - baseline.connected;
  if (idle <= 0) return c.dim("     —");
  return (delta / idle).toFixed(1).padStart(6);
}

async function tick(): Promise<void> {
  const s = await sample();
  await record("metrics.jsonl", { ...s });
  console.log(
    `  ${c.dim(stamp())}  ${String(s.devices).padStart(7)}  ${String(s.connected).padStart(4)}  ${mib(s.memBytes)}  ${String(s.fds).padStart(5)}  ${String(s.pids).padStart(4)}   ${perDevice(s)}`,
  );
  if (maxSamples && ++n >= maxSamples) process.exit(0);
}

await tick();
setInterval(tick, intervalSec * 1000);
