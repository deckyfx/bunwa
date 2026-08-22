/**
 * Stage 0 socket-drop probe.
 *
 * Answers: how long does whatsmeow take to notice its socket to WhatsApp has
 * gone away, and how long to recover? That latency is the floor on how fast
 * bunwa can emit `device.disconnected` (docs/05) and it bounds the reconciler's
 * polling interval.
 *
 * Method: cut the container off its docker network, then poll its status
 * endpoint **through `docker exec`** — which reaches the container via the
 * daemon rather than the network, and so keeps working while the network is
 * down. Restore, and poll again for recovery.
 *
 * An earlier version watched container logs for a disconnect line. That does
 * not work: gowa logs nothing at all when the socket dies (docs/12). It also
 * hung, and left the network disconnected — hence the finally block below,
 * which is not optional.
 *
 *   bun run stage0:drop -- [--device stage0-a] [--outage 60]
 */
import { STAGE0, record, c, stamp } from "./config";

const NETWORK = process.env.GOWA_NETWORK ?? "bunwa-stage0_default";
const arg = (n: string): string | undefined => {
  const i = Bun.argv.indexOf(`--${n}`);
  return i > 0 ? Bun.argv[i + 1] : undefined;
};
const deviceId = arg("device") ?? "stage0-a";
const outageSec = Number(arg("outage") ?? 60);
const POLL_MS = 2000;

interface Status { connected: boolean; loggedIn: boolean; reachable: boolean }

/**
 * Read device status from inside the container.
 *
 * `docker exec` is deliberate: the published port is unreachable while the
 * container is off its network, but the daemon channel is not.
 */
async function status(): Promise<Status> {
  const p = Bun.spawn(
    ["docker", "exec", STAGE0.container, "wget", "-qO-", "-T", "3",
     `http://127.0.0.1:3000/devices/${encodeURIComponent(deviceId)}/status`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) return { connected: false, loggedIn: false, reachable: false };
  try {
    const r = (JSON.parse(out) as { results?: { is_connected?: boolean; is_logged_in?: boolean } }).results ?? {};
    return { connected: r.is_connected === true, loggedIn: r.is_logged_in === true, reachable: true };
  } catch {
    return { connected: false, loggedIn: false, reachable: false };
  }
}

async function network(action: "connect" | "disconnect"): Promise<void> {
  const p = Bun.spawn(["docker", "network", action, NETWORK, STAGE0.container], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  // "not connected"/"already exists" are benign when re-running after a crash.
  if ((await p.exited) !== 0 && !/not connected|already exists/i.test(err)) throw new Error(err.trim());
}

/** Poll until `want` matches `is_connected`, or give up. Returns elapsed ms. */
async function pollUntil(want: boolean, timeoutMs: number, label: string): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const s = await status();
    const elapsed = Math.round(performance.now() - t0);
    if (s.reachable && s.connected === want) {
      console.log(`  ${c.dim(stamp())} ${c.green(label)} after ${(elapsed / 1000).toFixed(1)}s`);
      return elapsed;
    }
    process.stdout.write(
      `\r  ${c.dim(stamp())} ${c.dim(`${(elapsed / 1000).toFixed(0)}s  connected=${s.connected} logged_in=${s.loggedIn}${s.reachable ? "" : " (unreachable)"}`)}   `,
    );
    await Bun.sleep(POLL_MS);
  }
  console.log(`\r  ${c.dim(stamp())} ${c.red(`${label}: no change within ${timeoutMs / 1000}s`)}          `);
  return null;
}

/**
 * A `finally` block does not run on SIGINT, and this probe leaves the engine
 * offline if it does not restore the network. Ctrl-C during the outage was the
 * failure mode that stranded the container the first time it was run.
 */
let networkCut = false;
let restoring = false;
async function restoreOnSignal(sig: string): Promise<void> {
  if (restoring) return;
  restoring = true;
  console.log(c.yellow(`\n  ${sig} received`));
  if (networkCut) {
    console.log(c.green("  restoring network before exit"));
    await network("connect").catch((e: unknown) => console.error(c.red(`  restore failed: ${String(e)}`)));
  }
  process.exit(130);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => void restoreOnSignal(sig));
}

console.log(c.bold("\n  stage0 socket-drop probe"));
console.log(c.dim(`  ${STAGE0.container} · ${NETWORK} · device ${deviceId} · outage ${outageSec}s`));
console.log(c.dim(`  polling via docker exec, so the cut does not blind us\n`));

const before = await status();
if (!before.connected) {
  console.log(c.yellow(`  device is not connected (connected=${before.connected} logged_in=${before.loggedIn}); nothing to drop`));
  process.exit(1);
}

let detectMs: number | null = null;
let recoverMs: number | null = null;

try {
  console.log(`  ${c.dim(stamp())} ${c.red("network disconnected")}`);
  await network("disconnect");
  networkCut = true;

  detectMs = await pollUntil(false, (outageSec + 120) * 1000, "noticed the socket died");

  const held = (detectMs ?? 0) + POLL_MS;
  if (held < outageSec * 1000) await Bun.sleep(outageSec * 1000 - held);
} finally {
  // Always restore. A probe that leaves the engine offline on failure is worse
  // than no probe at all.
  console.log(`\n  ${c.dim(stamp())} ${c.green("network restored")}`);
  await network("connect").catch((e: unknown) => console.error(c.red(`  restore failed: ${String(e)}`)));
  networkCut = false;
}

recoverMs = await pollUntil(true, 180_000, "reconnected");

await record("drop.jsonl", { deviceId, outageSec, detectMs, recoverMs });

console.log(c.bold("\n  results"));
console.log(`    detection  ${detectMs === null ? c.red("not observed") : c.bold(`${(detectMs / 1000).toFixed(1)}s`)}`);
console.log(`    recovery   ${recoverMs === null ? c.red("did not reconnect — manual reconnect needed") : c.bold(`${(recoverMs / 1000).toFixed(1)}s`)}`);
console.log(c.dim("\n  recorded to drop.jsonl\n"));
