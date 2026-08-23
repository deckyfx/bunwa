/**
 * The gowa adapter against a stubbed gowa.
 *
 * Every response shape here was taken from the live measurements in docs/12,
 * not invented — including the ones that surprised me, like the /devices list
 * disagreeing with /devices/{id}/status.
 */
import { describe, expect, test } from "bun:test";

import { GowaAdapter } from "../adapter";
import { EngineError } from "../../types";

/** A stub gowa. Routes are matched by suffix, which is enough here. */
function stubGowa(routes: Record<string, unknown>, record?: Array<{ url: string; body: string }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    record?.push({ url, body: typeof init?.body === "string" ? init.body : "[form]" });
    // Suffix first, then substring: "/devices" is a prefix of
    // "/devices/d1/login" and would otherwise shadow it. Length is not the
    // right tiebreak either — the specific route is the one at the end.
    const key = Object.keys(routes).find((k) => url.endsWith(k)) ?? Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return new Response("Method Not Allowed", { status: 405 });
    return new Response(JSON.stringify(routes[key]), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** Resolves to a public address, so the SSRF check runs without needing DNS. */
const publicLookup = async () => [{ address: "93.184.216.34" }];

const adapter = (fetchImpl: typeof fetch) =>
  new GowaAdapter({
    baseUrl: "http://127.0.0.1:3100",
    fetchImpl,
    lookupImpl: publicLookup,
    pollIntervalMs: 999_999,
  });

describe("provision", () => {
  test("is idempotent — an existing slot is success, not failure", async () => {
    // A retry after a timeout must not fail, or the claim flow wedges.
    const engine = adapter(stubGowa({ "/devices": { code: "ERROR", message: "device already exists" } }));
    await expect(engine.provision("d1")).resolves.toBeUndefined();
    await engine.close();
  });

  test("a genuine failure is raised", async () => {
    const engine = adapter(stubGowa({ "/devices": { code: "ERROR", message: "device manager unavailable" } }));
    await expect(engine.provision("d1")).rejects.toThrow(EngineError);
    await engine.close();
  });
});

describe("status", () => {
  test("reads the two booleans, not the list state", async () => {
    // The list reported "connected" for a slot that had never paired; only
    // /devices/{id}/status is trustworthy (docs/12).
    const engine = adapter(
      stubGowa({ "/status": { code: "SUCCESS", results: { is_connected: true, is_logged_in: false } } }),
    );
    await engine.provision("d1").catch(() => undefined);
    expect(await engine.status("d1")).toMatchObject({ connected: true, loggedIn: false });
    await engine.close();
  });
});

describe("pairing", () => {
  test("takes the QR from the login response body", async () => {
    // There is no QRDATA broadcast; an earlier reading of the source claimed
    // otherwise and observation disproved it.
    const engine = adapter(
      stubGowa({
        "/devices": { code: "SUCCESS" },
        "/login": { code: "SUCCESS", results: { qr_link: "http://x/qr.png", qr_duration: 30 } },
      }),
    );
    await engine.provision("d1");
    const session = await engine.startPairing("d1", "qr");
    expect(session.qr).toBe("http://x/qr.png");
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await engine.close();
  });
});

describe("send mapping", () => {
  const sent: Array<{ url: string; body: string }> = [];
  const engine = adapter(stubGowa({ "/send/": { code: "SUCCESS", results: { message_id: "3EB0" } } }, sent));

  test("maps each of the six v1 types onto gowa's endpoints", async () => {
    const to = "+628123456789";
    const media = { url: "https://example.com/f" };
    const cases = [
      [{ type: "text", to, text: "hi" }, "/send/message"],
      [{ type: "link", to, url: "https://x" }, "/send/link"],
      [{ type: "image", to, media }, "/send/image"],
      [{ type: "document", to, media, filename: "x.pdf" }, "/send/file"],
      [{ type: "audio", to, media }, "/send/audio"],
      [{ type: "video", to, media }, "/send/video"],
    ] as const;

    for (const [action, path] of cases) {
      sent.length = 0;
      const result = await engine.send("d1", action);
      expect(result.messageId).toBe("3EB0");
      expect(sent[0]!.url).toContain(path);
    }
  });

  test("an empty recipient is fatal, not retryable", async () => {
    await expect(engine.send("d1", { type: "text", to: "  ", text: "x" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  test("a media URL resolving to a private address is refused before gowa sees it", async () => {
    // gowa resolves the name itself inside the container, so validating only
    // the literal would let a public-looking host reach loopback one hop on.
    const blocked = new GowaAdapter({
      baseUrl: "http://127.0.0.1:3100",
      fetchImpl: stubGowa({ "/send/": { code: "SUCCESS", results: { message_id: "x" } } }),
      lookupImpl: async () => [{ address: "169.254.169.254" }],
      pollIntervalMs: 999_999,
    });
    await expect(
      blocked.send("d1", { type: "image", to: "+62811", media: { url: "https://evil.example/x.png" } }),
    ).rejects.toMatchObject({ retryable: false });
    await blocked.close();
  });

  test("base64 media is refused rather than silently mishandled", async () => {
    await expect(
      engine.send("d1", { type: "image", to: "+62811", media: { base64: "AAAA", mimeType: "image/png" } }),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe("error classification", () => {
  test("an unrecognised message defaults to retryable", async () => {
    // gowa panics on error paths and renders one opaque 500 with prose. A
    // wrong "fatal" loses a message a retry would have delivered.
    const engine = adapter(stubGowa({ "/send/": { code: "ERROR", message: "context deadline exceeded" } }));
    await expect(engine.send("d1", { type: "text", to: "+62811", text: "x" })).rejects.toMatchObject({
      retryable: true,
    });
    await engine.close();
  });

  test("a recognised permanent failure is not retried", async () => {
    const engine = adapter(stubGowa({ "/send/": { code: "ERROR", message: "device not found" } }));
    await expect(engine.send("d1", { type: "text", to: "+62811", text: "x" })).rejects.toMatchObject({
      retryable: false,
    });
    await engine.close();
  });

  test("a non-JSON body is reported as retryable rather than crashing the parse", async () => {
    // gowa answers "Method Not Allowed" as bare text on the wrong verb.
    const engine = adapter((async () => new Response("Method Not Allowed", { status: 405 })) as unknown as typeof fetch);
    await expect(engine.status("d1")).rejects.toMatchObject({ retryable: true });
    await engine.close();
  });
});

describe("polling drives lifecycle events", () => {
  test("a logout observed by polling becomes device.logged_out", async () => {
    // The event gowa never delivers by webhook. Everything a tenant learns
    // about a device dying is produced by this loop.
    let loggedIn = true;
    const engine = adapter(
      (async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/status")) {
          return Response.json({ code: "SUCCESS", results: { is_connected: loggedIn, is_logged_in: loggedIn } });
        }
        if (url.endsWith("/devices")) {
          // The list is where a JID comes from; the status endpoint has none.
          return Response.json({
            code: "SUCCESS",
            results: [{ id: "d1", jid: loggedIn ? "628123@s.whatsapp.net" : "" }],
          });
        }
        return Response.json({ code: "SUCCESS" });
      }) as unknown as typeof fetch,
    );

    await engine.provision("d1");
    const seen: string[] = [];
    void (async () => {
      for await (const event of engine.subscribe()) seen.push(event.type);
    })();

    await engine.pollOnce();          // connected
    loggedIn = false;
    await engine.pollOnce();          // logged out
    await Bun.sleep(20);

    expect(seen).toContain("device.connected");
    expect(seen).toContain("device.logged_out");
    await engine.close();
  });
});
