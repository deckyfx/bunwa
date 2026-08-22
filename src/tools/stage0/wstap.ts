/**
 * Stage 0 WebSocket tap.
 *
 * Connects to gowa's internal broadcast socket and records every message.
 * This is the channel that carries DEVICE_LOGGED_OUT, LOGIN_SUCCESS, QRDATA and
 * the passkey codes — the lifecycle information that never reaches a webhook
 * (docs/01). The stage 1 gowa adapter is planned to bridge exactly this, so the
 * tap doubles as a prototype of that bridge.
 */
import { STAGE0, record, c, stamp } from "./config";

const seen = new Map<string, number>();
let attempt = 0;

/**
 * gowa gates `/ws` behind its device middleware, so the upgrade is rejected
 * with DEVICE_ID_REQUIRED until at least one device slot exists — even though
 * the broadcast hub itself is global and every client receives every message.
 * Any valid device id gets you the full stream.
 */
async function anyDeviceId(): Promise<string | null> {
  try {
    const res = await fetch(`${STAGE0.gowaBaseUrl}/devices`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const first = body.results?.[0];
    const id = first?.["id"] ?? first?.["device_id"] ?? first?.["name"];
    return id === undefined ? null : String(id);
  } catch {
    return null;
  }
}

/** Connect, log every frame, and reconnect with a bounded backoff. */
async function connect(): Promise<void> {
  const deviceId = await anyDeviceId();
  if (deviceId === null) {
    console.log(`${c.dim(stamp())} ${c.yellow("waiting")} ${c.dim("no device slot yet — /ws needs one; POST /devices first")}`);
    setTimeout(() => void connect(), 5000);
    return;
  }

  const url = `${STAGE0.gowaWsUrl}?device_id=${encodeURIComponent(deviceId)}`;
  const ws = new WebSocket(url);

  ws.onopen = () => {
    attempt = 0;
    console.log(`${c.dim(stamp())} ${c.green("connected")} ${c.dim(url)}`);
  };

  // Frames are handled through a chain rather than an async handler: an async
  // onmessage discards its rejection and lets two frames interleave, so a
  // broadcast can be lost or recorded out of order.
  let chain: Promise<void> = Promise.resolve();
  ws.onmessage = (ev) => {
    const raw = String(ev.data);
    let msg: Record<string, unknown> = {};
    try { msg = JSON.parse(raw) as Record<string, unknown>; } catch { msg = { raw }; }

    const code = String(msg["code"] ?? msg["Code"] ?? "UNKNOWN");
    seen.set(code, (seen.get(code) ?? 0) + 1);

    const detail = JSON.stringify(msg["result"] ?? msg["Result"] ?? msg["message"] ?? "").slice(0, 90);
    console.log(`${c.dim(stamp())} ${c.yellow(code.padEnd(24))} ${c.dim(detail)}`);

    chain = chain
      .then(() => record("ws.jsonl", { code, msg }))
      .catch((err: unknown) => console.error(c.red(`  failed to record ${code}: ${String(err)}`)));
  };

  ws.onclose = () => {
    const delay = Math.min(1000 * 2 ** attempt++, 15_000);
    console.log(`${c.dim(stamp())} ${c.red("closed")} ${c.dim(`retry in ${delay}ms`)}`);
    setTimeout(() => void connect(), delay);
  };

  ws.onerror = () => { /* onclose handles the retry */ };
}

console.log(c.bold("stage0 /ws tap"));
console.log(c.dim("  recording every gowa broadcast to ws.jsonl\n"));
void connect();

process.on("SIGINT", () => {
  console.log(c.bold("\n\nbroadcast codes observed:"));
  if (seen.size === 0) console.log(c.yellow("  (none)"));
  for (const [k, v] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  process.exit(0);
});
