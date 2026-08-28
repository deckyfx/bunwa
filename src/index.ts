/**
 * The API with the console. The default entry point.
 *
 * This path is what `bun run start`, the Dockerfile CMD and CI all reach for,
 * so it has to be the one that actually serves. It briefly only exported
 * main(), which meant every one of those started a process that exited 0
 * immediately and served nothing.
 */
import { main } from "./boot";
import consolePage from "./console/index.html";

await main(consolePage);
