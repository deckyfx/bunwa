/**
 * Stage 0 webhook sink.
 *
 * Receives every webhook gowa forwards, verifies the HMAC signature, records it
 * to webhooks.jsonl, and prints one line per event. Its purpose is to establish
 * empirically which events gowa does and does not deliver — in particular
 * whether any device lifecycle event ever arrives (docs/01, open question).
 */
import { timingSafeEqual } from "node:crypto";

import { STAGE0, record, c, stamp, containerReachableBindAddress } from "./config";

/** The fields the harness reads off a gowa webhook; the rest is kept verbatim. */
interface WebhookPayload {
  event?: unknown;
  type?: unknown;
  from?: unknown;
  sender_id?: unknown;
  device_id?: unknown;
  session_id?: unknown;
  [key: string]: unknown;
}

/** Event types seen so far, so the summary can show coverage at a glance. */
const seen = new Map<string, number>();

/** Verify gowa's HMAC-SHA256 signature over the raw body. */
function verify(body: string, header: string | null): boolean {
  if (!header) return false;
  const expected = new Bun.CryptoHasher("sha256", STAGE0.webhookSecret).update(body).digest("hex");
  const given = header.replace(/^sha256=/, "").trim();
  if (expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/** Narrowest address gowa can still reach via host.docker.internal. */
const bindAddress = await containerReachableBindAddress();

const server = Bun.serve({
  port: STAGE0.sinkPort,
  hostname: bindAddress,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/summary") {
      return Response.json(Object.fromEntries([...seen].sort((a, b) => b[1] - a[1])));
    }
    if (req.method !== "POST") return new Response("stage0 sink", { status: 200 });

    const body = await req.text();
    const sigHeader = req.headers.get("X-Hub-Signature-256") ?? req.headers.get("x-hub-signature-256");
    const valid = verify(body, sigHeader);

    let payload: WebhookPayload = {};
    try { payload = JSON.parse(body) as WebhookPayload; } catch { /* keep raw */ }

    const event = String(payload.event ?? payload.type ?? "unknown");
    const from = String(payload.from ?? payload.sender_id ?? "");
    const device = String(payload.device_id ?? payload.session_id ?? "");

    // Unsigned or wrongly-signed posts are recorded under a separate file so a
    // third party cannot inject rows into the measurement data.
    seen.set(valid ? event : `${event} (unsigned)`, (seen.get(valid ? event : `${event} (unsigned)`) ?? 0) + 1);
    await record(valid ? "webhooks.jsonl" : "webhooks-rejected.jsonl", { event, device, from, valid, payload });

    const flag = valid ? c.green("sig ok") : c.red("SIG BAD");
    console.log(
      `${c.dim(stamp())} ${c.cyan(event.padEnd(22))} ${flag}  ${c.dim(device.slice(0, 24))} ${c.dim(from.slice(0, 24))}`,
    );
    return new Response("ok");
  },
});

console.log(c.bold(`stage0 sink listening on ${bindAddress}:${server.port}`));
console.log(c.dim(`  gowa should POST to http://host.docker.internal:${server.port}/hook`));
console.log(c.dim(`  GET /summary for event-type counts; writing webhooks.jsonl`));
console.log(c.dim(`  unsigned posts are quarantined in webhooks-rejected.jsonl\n`));

process.on("SIGINT", () => {
  console.log(c.bold("\n\nevent types observed:"));
  if (seen.size === 0) console.log(c.yellow("  (none)"));
  for (const [k, v] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  const lifecycle = [...seen.keys()].filter((k) => /device|session|logout|connect|pair|qr/i.test(k));
  console.log(
    lifecycle.length
      ? c.green(`\n  lifecycle events delivered: ${lifecycle.join(", ")}`)
      : c.red("\n  no device lifecycle event was ever delivered by webhook  ← docs/00 claim #1"),
  );
  process.exit(0);
});
