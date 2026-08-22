/**
 * Stage 0 send test — the six v1 message types.
 *
 * Sends text, image, PDF, link-with-preview, audio and video through gowa and
 * records the exact request and response shapes. Those shapes become the
 * `SendAction` → gowa mapping in the stage 1 adapter (docs/03), so this is a
 * specification exercise as much as a smoke test.
 *
 * Fixtures are generated locally with ffmpeg and served from a temporary
 * in-process HTTP server, so nothing is fetched from the internet and no
 * third-party host sees the traffic.
 *
 *   bun run stage0:send -- --to 628123456789 [--device stage0-a] [--only text,image]
 *
 * SENDS REAL WHATSAPP MESSAGES. --to is mandatory and has no default.
 */
import { STAGE0, record, c, stamp } from "./config";

const argv = Bun.argv;
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? argv[i + 1] : undefined;
};

const to = arg("to");
const device = arg("device") ?? "stage0-a";
const only = arg("only")?.split(",").map((s) => s.trim());
/** Port the fixture server binds; gowa reaches it via host.docker.internal. */
const FIXTURE_PORT = Number(arg("fixture-port") ?? 3998);
const FIXTURE_HOST = arg("fixture-host") ?? "host.docker.internal";

if (!to) {
  console.error(c.red("--to <phone> is required. This sends real WhatsApp messages."));
  process.exit(1);
}

/** Build the small set of media fixtures, in memory. */
async function buildFixtures(): Promise<Map<string, { bytes: Uint8Array; type: string }>> {
  const out = new Map<string, { bytes: Uint8Array; type: string }>();

  /** Run ffmpeg to stdout and capture the bytes. */
  const ff = async (args: string[]): Promise<Uint8Array> => {
    const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args, "-"], {
      stdout: "pipe", stderr: "pipe",
    });
    const bytes = new Uint8Array(await new Response(p.stdout).arrayBuffer());
    if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
    return bytes;
  };

  out.set("bunwa.png", {
    bytes: await ff(["-f", "lavfi", "-i", "color=c=0x1f6feb:s=480x270", "-frames:v", "1", "-f", "image2", "-c:v", "png"]),
    type: "image/png",
  });
  out.set("bunwa.mp3", {
    bytes: await ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-f", "mp3"]),
    type: "audio/mpeg",
  });
  out.set("bunwa.mp4", {
    bytes: await ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      "-movflags", "frag_keyframe+empty_moov", "-f", "mp4",
    ]),
    type: "video/mp4",
  });

  // A minimal but valid single-page PDF; no toolchain needed.
  const pdf = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 52>>stream",
    "BT /F1 18 Tf 20 45 Td (bunwa stage 0) Tj ET",
    "endstream endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "trailer<</Root 1 0 R>>",
  ].join("\n");
  out.set("bunwa.pdf", { bytes: new TextEncoder().encode(pdf), type: "application/pdf" });

  return out;
}

interface Case {
  name: string;
  path: string;
  /** JSON body, or a function building multipart form data. */
  body: Record<string, string> | (() => FormData);
  json: boolean;
}

const fixtures = await buildFixtures();
const fixtureBase = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;

const fixtureServer = Bun.serve({
  port: FIXTURE_PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    const f = fixtures.get(name);
    return f
      ? new Response(f.bytes, { headers: { "Content-Type": f.type, "Content-Length": String(f.bytes.length) } })
      : new Response("not found", { status: 404 });
  },
});

const cases: Case[] = [
  { name: "text", path: "/send/message", json: true, body: { phone: to, message: `bunwa stage 0 — plain text, e.g. OTP 448126` } },
  { name: "link", path: "/send/link", json: true, body: { phone: to, link: "https://bun.sh", caption: "bunwa stage 0 — link with preview" } },
  { name: "image", path: "/send/image", json: false, body: () => form({ phone: to, caption: "bunwa stage 0 — image", image_url: `${fixtureBase}/bunwa.png` }) },
  { name: "document", path: "/send/file", json: false, body: () => form({ phone: to, caption: "bunwa stage 0 — pdf", file_url: `${fixtureBase}/bunwa.pdf` }) },
  { name: "audio", path: "/send/audio", json: false, body: () => form({ phone: to, audio_url: `${fixtureBase}/bunwa.mp3` }) },
  { name: "video", path: "/send/video", json: false, body: () => form({ phone: to, caption: "bunwa stage 0 — video", video_url: `${fixtureBase}/bunwa.mp4` }) },
];

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

console.log(c.bold(`\n  stage 0 send test → ${to}  (device ${device})`));
console.log(c.dim(`  fixtures served at ${fixtureBase}\n`));

const results: Array<{ name: string; ok: boolean; ms: number; detail: string }> = [];

for (const t of cases) {
  if (only && !only.includes(t.name)) continue;
  const started = performance.now();
  const isJson = t.json;
  const init: RequestInit = {
    method: "POST",
    headers: { "X-Device-Id": device, ...(isJson ? { "Content-Type": "application/json" } : {}) },
    body: isJson ? JSON.stringify(t.body) : (t.body as () => FormData)(),
    signal: AbortSignal.timeout(120_000),
  };

  let ok = false;
  let detail = "";
  let payload: unknown = null;
  try {
    const res = await fetch(`${STAGE0.gowaBaseUrl}${t.path}`, init);
    payload = await res.json();
    const p = payload as { code?: string; message?: string; results?: { message_id?: string } };
    ok = res.ok && p.code === "SUCCESS";
    detail = ok ? String(p.results?.message_id ?? "sent") : `${res.status} ${p.code ?? ""} ${p.message ?? ""}`.trim();
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  const ms = Math.round(performance.now() - started);
  results.push({ name: t.name, ok, ms, detail });
  await record("sends.jsonl", { type: t.name, path: t.path, ok, ms, request: isJson ? t.body : "multipart", response: payload });
  console.log(`  ${c.dim(stamp())} ${ok ? c.green("✓") : c.red("✗")} ${t.name.padEnd(9)} ${String(ms).padStart(6)}ms  ${c.dim(detail.slice(0, 70))}`);
}

fixtureServer.stop(true);

const passed = results.filter((r) => r.ok).length;
console.log(c.bold(`\n  ${passed}/${results.length} sent`));
if (passed < results.length) console.log(c.yellow("  check the failures above; details in sends.jsonl"));
console.log(c.dim("  watch the sink for the matching message.ack webhooks\n"));
