/**
 * A DOM for component tests.
 *
 * Registered before any test file imports React, which is why this is a
 * preload rather than an import inside a test: React reads `document` at
 * module scope, so a DOM installed later is installed too late.
 *
 * Bun's fetch is put back afterwards. happy-dom installs its own, and once the
 * console moved into src/ this preload became global — so every server test
 * silently got a fetch that cannot reach a real socket. The symptom was a
 * listener reporting a port and then refusing every connection, which reads as
 * a broken server rather than a substituted client.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const realFetch = globalThis.fetch;
const realHeaders = globalThis.Headers;
const realRequest = globalThis.Request;
const realResponse = globalThis.Response;
const realAbortController = globalThis.AbortController;
const realAbortSignal = globalThis.AbortSignal;

GlobalRegistrator.register();

// Restored after registration, in this order: the DOM is what components need,
// and real HTTP is what the API tests need. Nothing in the console talks to a
// socket directly — it goes through Eden, which uses whatever fetch is here.
globalThis.fetch = realFetch;
globalThis.Headers = realHeaders;
globalThis.Request = realRequest;
globalThis.Response = realResponse;

// AbortController especially. happy-dom subclasses it, and Elysia uses the
// request signal to decide when a streamed response is finished — with the
// subclass in place a generator route answered 200 and then produced nothing,
// because the stream was treated as aborted the moment it started. That is
// indistinguishable from a broken route, and it cost hours.
globalThis.AbortController = realAbortController;
globalThis.AbortSignal = realAbortSignal;
