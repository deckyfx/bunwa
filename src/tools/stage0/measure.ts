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
  /** null when the docker call failed — never conflate that with zero. */
  memBytes: number | null;
  fds: number | null;
  pids: number | null;
}

/**
 * Read one line of `docker stats`, which reports memory and pid count.
 *
 * Returns null rather than zeros when docker fails: a zero written to
 * metrics.jsonl is indistinguishable from a real measurement, and poisons any
 * later derivation with a negative delta.
 */
async function dockerStats(): Promise<{ memBytes: number; pids: number } | null> {
  const proc = Bun.spawn(
    ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}|{{.PIDs}}", STAGE0.container],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) return null;
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

/**
 * Count open file descriptors inside the container.
 *
 * `ls /proc/*∕fd | wc -l` counts the per-directory headers and blank lines that
 * `ls` emits when given several directories, inflating the total by roughly
 * 75%. Listing each directory separately counts only real descriptors.
 */
async function openFds(): Promise<number | null> {
  const proc = Bun.spawn(
    ["docker", "exec", STAGE0.container, "sh", "-c",
     'for d in /proc/[0-9]*/fd; do ls "$d" 2>/dev/null; done | wc -l'],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) return null;
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
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
  const [stats, fds, counts] = await Promise.all([dockerStats(), openFds(), deviceCounts()]);
  return { ...counts, memBytes: stats?.memBytes ?? null, pids: stats?.pids ?? null, fds };
}

const args = Bun.argv.slice(2);
const intervalSec = Number(args[args.indexOf("--interval") + 1]) || 10;
const maxSamples = Number(args[args.indexOf("--samples") + 1]) || 0;

const mib = (b: number | null) => (b === null ? "    n/a" : (b / 1024 ** 2).toFixed(1).padStart(7));
const num = (v: number | null, w: number) => (v === null ? "n/a".padStart(w) : String(v).padStart(w));

console.log(c.bold(`stage0 measurement — every ${intervalSec}s${maxSamples ? `, ${maxSamples} samples` : ", until Ctrl-C"}`));
console.log(c.dim("  writing metrics.jsonl\n"));
console.log(c.dim("  time         devices  conn   mem MiB    fds  pids   MiB/device"));

/**
 * Marginal cost per connected device.
 *
 * The baseline is the first sample **with zero devices connected**, not simply
 * the first sample. Anchoring on process start silently breaks the metric when
 * the sampler is restarted against an already-paired device: the baseline then
 * already contains that device's memory, the divisor collapses to zero, and the
 * column reports nothing for the rest of the run.
 */
let baseline: Sample | null = null;
let n = 0;

function perDevice(s: Sample): string {
  if (baseline === null || baseline.memBytes === null || s.memBytes === null) return c.dim("     —");
  const devices = s.connected - baseline.connected;
  if (devices <= 0) return c.dim("     —");
  const delta = (s.memBytes - baseline.memBytes) / 1024 ** 2;
  return (delta / devices).toFixed(1).padStart(6);
}

async function tick(): Promise<void> {
  const s = await sample();
  if (baseline === null && s.connected === 0 && s.memBytes !== null) baseline = s;
  await record("metrics.jsonl", { ...s, baseline: baseline === s });
  console.log(
    `  ${c.dim(stamp())}  ${num(s.devices, 7)}  ${num(s.connected, 4)}  ${mib(s.memBytes)}  ${num(s.fds, 5)}  ${num(s.pids, 4)}   ${perDevice(s)}`,
  );
}

/**
 * Self-scheduling loop rather than setInterval.
 *
 * A tick awaits several docker calls and up to N HTTP requests and regularly
 * exceeds a short interval; setInterval would start the next tick before the
 * previous finished, interleaving samples and dropping the even spacing the
 * per-device derivation depends on. It also discards the promise, so one
 * rejected docker call would terminate the run.
 */
let stopped = false;
/** Resolved by the signal handler so the pause can be cut short. */
let wake: () => void = () => undefined;
process.on("SIGINT", () => {
  if (stopped) process.exit(130); // second Ctrl-C exits immediately
  stopped = true;
  console.log(c.dim("\n  stopping after the current sample"));
  wake();
});

while (!stopped) {
  try {
    await tick();
  } catch (err) {
    console.error(c.red(`  sample failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (maxSamples && ++n >= maxSamples) break;
  // Race the pause against the signal: an uninterruptible sleep makes the tool
  // look like it is ignoring Ctrl-C for up to a full interval.
  await Promise.race([Bun.sleep(intervalSec * 1000), new Promise<void>((r) => { wake = r; })]);
}

if (baseline === null) {
  console.log(c.yellow("\n  no zero-device baseline was captured, so MiB/device could not be derived."));
  console.log(c.dim("  start the sampler before pairing, or stop the device and re-run."));
}
