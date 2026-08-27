/**
 * A DOM for component tests.
 *
 * Registered globally before any test file imports React, which is why this is
 * a preload rather than an import inside a test: React reads `document` at
 * module scope, so a DOM installed later is installed too late.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
