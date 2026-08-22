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
import { STAGE0, record, c, stamp, containerReachableBindAddress, maskPhone } from "./config";

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
/** Narrowest address gowa can still fetch fixtures from. */
const FIXTURE_BIND = await containerReachableBindAddress();

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

  out.set("bunwa.pdf", { bytes: minimalPdf("bunwa stage 0"), type: "application/pdf" });

  return out;
}

/**
 * Build a single-page PDF with a correct stream Length and a real cross-reference
 * table. Hand-writing the offsets matters: a wrong /Length or a missing xref
 * makes the file structurally invalid, and "WhatsApp accepted it" would then
 * prove less than the test claims.
 */
function minimalPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const content = `BT /F1 18 Tf 20 45 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(enc.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = enc.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc.encode(pdf);
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
  hostname: FIXTURE_BIND,
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
console.log(c.dim(`  fixtures served on ${FIXTURE_BIND}:${FIXTURE_PORT}, fetched by gowa as ${fixtureBase}\n`));

const results: Array<{ name: string; ok: boolean; ms: number; detail: string }> = [];

/** The fixture server must not outlive the run, including on a thrown case. */
try {
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
  // The recipient is masked before it reaches disk. sends.jsonl is git-ignored,
  // but that protects the repository, not a copied log or a shared machine.
  const request = isJson ? { ...(t.body as Record<string, string>), phone: maskPhone(to) } : "multipart";
  await record("sends.jsonl", {
    type: t.name, path: t.path, ok, ms, request,
    response: JSON.parse(maskPhone(JSON.stringify(payload ?? null))) as unknown,
  });
  console.log(`  ${c.dim(stamp())} ${ok ? c.green("✓") : c.red("✗")} ${t.name.padEnd(9)} ${String(ms).padStart(6)}ms  ${c.dim(detail.slice(0, 70))}`);
}

} finally {
  fixtureServer.stop(true);
}

const passed = results.filter((r) => r.ok).length;
console.log(c.bold(`\n  ${passed}/${results.length} sent`));
if (passed < results.length) console.log(c.yellow("  check the failures above; details in sends.jsonl"));
console.log(c.dim("  watch the sink for the matching message.ack webhooks\n"));
