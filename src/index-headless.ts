/**
 * The API alone.
 *
 * No console, and no React in the bundle: the page is not imported here, so a
 * headless build cannot accidentally carry the thing it exists to exclude.
 * `/app` answers 404 rather than being absent, which tells an operator who
 * expected the console that they are running the wrong image.
 */
import { main } from "./index";

await main();
