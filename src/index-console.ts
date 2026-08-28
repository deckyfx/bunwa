/**
 * The API with the console mounted.
 *
 * One Elysia app serving both, so the browser talks to a single origin and
 * Eden types its calls against the very app that answers them. The console
 * was briefly a second Elysia on another port with its own copy of the
 * framework; the two versions drifted within a day, and the proxy between
 * them silently pointed at the wrong port.
 */
import { main } from "./index";
import consolePage from "./console/index.html";

await main(consolePage);
