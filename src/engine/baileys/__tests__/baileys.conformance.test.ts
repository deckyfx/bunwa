/**
 * The conformance suite against the Baileys adapter.
 *
 * `canPairUnattended` is true here, and the qualifier matters: pairing is
 * driven through a stub, not through WhatsApp. Against the real socket it
 * would be false — pairing needs a person holding a phone — and an earlier
 * version of this file said so while setting true, which left a reader unable
 * to tell which claim was current.
 *
 * The flag is declared up front rather than discovered, because a `pair()`
 * that bails at runtime leaves the callback returning normally and the runner
 * records a pass — which is how seven checks were once reported green for an
 * engine that had never run them.
 *
 * A real database is set up here, unlike the FakeEngine run. This engine keeps
 * credentials in SQLite, so storage is a genuine dependency rather than test
 * scaffolding, and running it against nothing produced "no such table"
 * failures that looked like contract violations.
 */
import { beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runConformanceSuite } from "../../conformance";
import { BaileysAdapter } from "../adapter";
import { StubSocket } from "./stub-socket";

const sockets: StubSocket[] = [];
import { createDatabase, resetDatabase } from "../../../db";
import { MigrationManager } from "../../../db/migration-manager";
import { resetConfig } from "../../../config/env";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-bconf-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  Bun.env["CREDENTIAL_ENCRYPTION_KEY"] = "a".repeat(64);
  await MigrationManager.runMigrations(createDatabase(join(dir, "t.sqlite")));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
});

runConformanceSuite("BaileysAdapter (stubbed)", {
  // Pairing is driven through the stub, so the suite can exercise the paired
  // half of the contract without a phone. What it does not prove is that
  // Baileys itself behaves as the stub does — that is what the live run
  // against a real device is for, and it remains outstanding.
  canPairUnattended: true,
  create: () => {
    const socket = new StubSocket();
    sockets.push(socket);
    return new BaileysAdapter({ openSocket: () => Promise.resolve(socket) });
  },
  pair: async (engine, deviceId) => {
    await engine.provision(deviceId);
    const socket = sockets[sockets.length - 1]!;
    // startPairing opens the socket, so the QR has to arrive after it is
    // called rather than before.
    const pairing = engine.startPairing(deviceId, "qr");
    socket.emit({ kind: "qr", qr: "STUB-QR" });
    await pairing;
    socket.becomeConnected();
    // The adapter learns of the connection through its pump, which is a
    // separate task.
    await Bun.sleep(20);
    return true;
  },
  destroy: async (engine) => {
    await engine.close();
  },
});
