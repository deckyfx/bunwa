/**
 * The gowa adapter against the shared contract.
 *
 * Runs the same suite as the fake. Pairing needs a phone, so `pair` returns
 * false and those tests report as skipped — a partial pass, visible as such,
 * rather than a green tick that means nothing.
 *
 * Against a live gowa this file needs only GOWA_URL set; the harness in
 * deploy/stage0 provides one.
 */
import { runConformanceSuite } from "../../conformance";
import { GowaAdapter } from "../adapter";

/** A stub gowa good enough for the unattended half of the suite. */
function stubbedGowa(): typeof fetch {
  const provisioned = new Set<string>();
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/devices") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { device_id?: string };
      if (body.device_id !== undefined) provisioned.add(body.device_id);
      return Response.json({ code: "SUCCESS", results: { id: body.device_id } });
    }
    if (url.endsWith("/devices")) {
      return Response.json({ code: "SUCCESS", results: [...provisioned].map((id) => ({ id, jid: "" })) });
    }
    if (url.endsWith("/status")) {
      const id = url.split("/devices/")[1]?.split("/")[0] ?? "";
      if (!provisioned.has(decodeURIComponent(id))) {
        return Response.json({ code: "DEVICE_NOT_FOUND", message: "device not found" });
      }
      return Response.json({ code: "SUCCESS", results: { is_connected: false, is_logged_in: false } });
    }
    if (url.endsWith("/login")) {
      return Response.json({ code: "SUCCESS", results: { qr_link: "http://x/qr.png", qr_duration: 30 } });
    }
    if (url.includes("/send/")) {
      // Not connected, so gowa refuses — the state the suite asserts on.
      return Response.json({ code: "ERROR", message: "device is not connected" });
    }
    return Response.json({ code: "SUCCESS" });
  }) as unknown as typeof fetch;
}

const live = Bun.env["GOWA_URL"];

runConformanceSuite(live === undefined ? "GowaAdapter (stubbed)" : `GowaAdapter (live ${live})`, {
  canPairUnattended: false,
  create: () =>
    new GowaAdapter({
      baseUrl: live ?? "http://127.0.0.1:3100",
      pollIntervalMs: 999_999,
      ...(live === undefined ? { fetchImpl: stubbedGowa() } : {}),
    }),
  // Pairing needs a human with a phone, so the dependent cases are registered
  // as skipped rather than run — and, previously, rather than passed.
  pair: async () => false,
});
