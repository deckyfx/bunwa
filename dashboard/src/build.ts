/**
 * Bundle the console to `dist/`.
 *
 * The output is what `bunwa:full` copies in and `bunwa:api` does not, which is
 * the whole mechanism behind two tags from one binary: the control plane serves
 * `/app/*` only when the files are there, so nothing needs a build flag or a
 * runtime switch to tell the images apart (docs/07).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "dist");

// Removed rather than overwritten. A stale asset from a previous build is
// served just as happily as a current one, and the failure looks like a
// caching problem rather than a build problem.
await rm(OUT, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "index.html")],
  outdir: OUT,
  target: "browser",
  minify: true,
  // Served from /app, so every generated URL has to carry that prefix or the
  // page loads and its script 404s — which renders as a blank screen with no
  // error, the least diagnosable failure available.
  publicPath: "/app/",
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  // Exit non-zero, or a failed build produces an empty dist that the image
  // copies without complaint and the operator discovers in a browser.
  process.exit(1);
}

const total = result.outputs.reduce((sum, o) => sum + o.size, 0);
console.log(`built ${String(result.outputs.length)} file(s), ${(total / 1024).toFixed(0)} KiB -> ${OUT}`);
for (const output of result.outputs) {
  console.log(`  ${output.path.replace(OUT, "dist")}  ${(output.size / 1024).toFixed(1)} KiB`);
}
