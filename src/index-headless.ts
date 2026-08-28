/**
 * The API alone.
 *
 * The console page is not imported here, so a headless build cannot carry
 * React to serve a route it never mounts. /app answers a 404 that names the
 * build rather than being silently absent.
 */
import { main } from "./boot";

await main();
