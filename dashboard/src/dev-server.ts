/**
 * The dashboard in development, with the API alongside it.
 *
 * Bun serves the SPA and proxies `/v1` to the control plane, so the browser
 * makes same-origin requests and CORS never enters the picture. In production
 * there is no proxy: `bunwa:full` serves both from one origin, which is the
 * arrangement docs/07 describes.
 */
import index from "./index.html";

const API = process.env["BUNWA_API"] ?? "http://127.0.0.1:3000";
const PORT = Number(process.env["DASHBOARD_PORT"] ?? 5173);

const server = Bun.serve({
  port: PORT,
  routes: {
    "/": index,
    "/app/*": index,
  },
  async fetch(request) {
    const url = new URL(request.url);

    // Only /v1 is proxied. A catch-all would forward the SPA's own asset
    // requests to the API and turn a missing file into a confusing 404 from
    // the wrong server.
    if (url.pathname.startsWith("/v1")) {
      const target = new URL(url.pathname + url.search, API);
      return fetch(new Request(target, request));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`dashboard  http://localhost:${server.port}`);
console.log(`proxying   /v1 -> ${API}`);
