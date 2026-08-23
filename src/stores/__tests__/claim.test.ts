/**
 * The claim flow — the reason this project exists.
 *
 * Three outcomes, and the middle one is the product: a customer already paired
 * for a project gets a second environment with nothing asked of them, while a
 * different project must ask the phone holder first.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { consentEvents, deviceConsents, devices, virtualDevices } from "../../db/schema";
import { DeviceStore, CONSENT_TTL_MS } from "../device-store";
import { EnvironmentStore } from "../environment-store";
import { ProjectStore } from "../project-store";
import { ConflictError, ValidationError } from "../errors";
import { resetConfig } from "../../config/env";

let dir: string;
let database: Database;
let grandeProd: string;
let grandeStaging: string;
let rivalProd: string;
let grandeId: string;

const NUMBER = "+628123456789";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-claim-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const grande = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const rival = await ProjectStore.create({ slug: "rival", displayName: "Rival" }, database);
  grandeId = grande.id;
  grandeProd = (await EnvironmentStore.create({ projectId: grande.id, slug: "production" }, database)).id;
  grandeStaging = (await EnvironmentStore.create({ projectId: grande.id, slug: "staging" }, database)).id;
  rivalProd = (await EnvironmentStore.create({ projectId: rival.id, slug: "production" }, database)).id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

const claim = (environmentId: string, alias: string, msisdn = NUMBER) =>
  DeviceStore.claim({ environmentId, msisdn, alias }, database);

describe("normalisation", () => {
  test("stores one form, so a number written two ways is one device", () => {
    // Two devices for one phone would silently break the "already paired?"
    // lookup that the whole claim flow depends on.
    for (const written of ["+62 812-3456-789", "628123456789", "+628123456789", " (628)1234-56789 "]) {
      expect(DeviceStore.normaliseMsisdn(written)).toBe("+628123456789");
    }
  });

  test("rejects what is not a phone number", () => {
    for (const bad of ["", "abc", "+0123456789", "+1", "+" + "9".repeat(20)]) {
      expect(() => DeviceStore.normaliseMsisdn(bad)).toThrow(ValidationError);
    }
  });
});

describe("outcome 1 — a number nobody has paired", () => {
  test("provisions the device and waits for a scan", async () => {
    const result = await claim(grandeProd, "otp-sender");
    expect(result.outcome).toBe("pending_pairing");
    expect(result.virtualDevice.status).toBe("pending_pairing");
    expect(result.device.state).toBe("unpaired");
  });

  test("pairing for a project implies consent for that project", async () => {
    // They chose to pair for this product; asking again would be theatre.
    await claim(grandeProd, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    const consent = await DeviceStore.consentFor(device!.id, grandeId, database);
    expect(consent!.status).toBe("granted");
  });
});

describe("outcome 2 — the same project, a second environment", () => {
  test("activates immediately, asking the customer nothing", async () => {
    // This is the product. Onboarding staging after production must be silent.
    await claim(grandeProd, "otp-sender");
    const second = await claim(grandeStaging, "otp-sender");

    expect(second.outcome).toBe("active");
    expect(second.virtualDevice.status).toBe("active");
    expect(second.virtualDevice.activatedAt).toBeInstanceOf(Date);
    // No second consent row, and no new challenge.
    expect(await database.select().from(deviceConsents)).toHaveLength(1);
  });

  test("both environments share one device row", async () => {
    await claim(grandeProd, "otp-sender");
    await claim(grandeStaging, "otp-sender");
    expect(await database.select().from(devices)).toHaveLength(1);
    expect(await database.select().from(virtualDevices)).toHaveLength(2);
  });
});

describe("outcome 3 — a different project", () => {
  test("asks the phone holder rather than granting access", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "their-alias");

    expect(rival.outcome).toBe("awaiting_confirmation");
    expect(rival.virtualDevice.status).toBe("pending_consent");
    if (rival.outcome === "awaiting_confirmation") {
      expect(rival.consent.status).toBe("pending");
      expect(rival.consent.challengeToken).toBeString();
    }
  });

  test("a pending binding is not usable until answered", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    expect(rival.virtualDevice.status).not.toBe("active");
  });

  test("a yes activates it; a no leaves it inert", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");

    await DeviceStore.respondToConsent(
      rival.consent.challengeToken,
      "granted",
      "whatsapp_reply",
      { replyingJid: "628123456789@s.whatsapp.net", messageId: "ABC123" },
      database,
    );

    const [binding] = await database.select().from(virtualDevices).where(eq(virtualDevices.id, rival.virtualDevice.id));
    expect(binding!.status).toBe("active");
  });

  test("a denial does not activate anything", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");

    await DeviceStore.respondToConsent(rival.consent.challengeToken, "denied", "whatsapp_reply", {}, database);
    const [binding] = await database.select().from(virtualDevices).where(eq(virtualDevices.id, rival.virtualDevice.id));
    expect(binding!.status).toBe("pending_consent");
  });

  test("granting releases every environment of that project at once", async () => {
    // Consent is per project, so a sibling environment waiting on the same
    // answer is activated by it — not left needing its own challenge.
    await claim(grandeProd, "otp-sender");
    const rivalStaging = (await EnvironmentStore.create(
      { projectId: (await ProjectStore.findBySlug("rival", database))!.id, slug: "staging" },
      database,
    )).id;
    const first = await claim(rivalProd, "a");
    const second = await claim(rivalStaging, "b");
    if (first.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    if (second.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    // One outstanding question per project: the second environment must not
    // invalidate a challenge the phone holder may already be looking at.
    expect(second.consent.challengeToken).toBe(first.consent.challengeToken);

    await DeviceStore.respondToConsent(first.consent.challengeToken, "granted", "whatsapp_reply", {}, database);
    const bindings = await database.select().from(virtualDevices);
    const rivalBindings = bindings.filter((b) => b.environmentId === rivalProd || b.environmentId === rivalStaging);
    expect(rivalBindings.every((b) => b.status === "active")).toBe(true);
  });
});

describe("consent lifecycle", () => {
  test("an expired challenge cannot be answered", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");

    const later = new Date(Date.now() + CONSENT_TTL_MS + 1000);
    await expect(
      DeviceStore.respondToConsent(rival.consent.challengeToken, "granted", "whatsapp_reply", {}, database, later),
    ).rejects.toThrow(/expired/);
  });

  test("a challenge cannot be answered twice", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");

    await DeviceStore.respondToConsent(rival.consent.challengeToken, "granted", "whatsapp_reply", {}, database);
    await expect(
      DeviceStore.respondToConsent(rival.consent.challengeToken, "denied", "whatsapp_reply", {}, database),
    ).rejects.toThrow(ConflictError);
  });

  test("an unknown token resolves nothing", async () => {
    await expect(
      DeviceStore.respondToConsent(crypto.randomUUID(), "granted", "whatsapp_reply", {}, database),
    ).rejects.toThrow();
  });

  test("revoking one project leaves the device's other projects alone", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    await DeviceStore.respondToConsent(rival.consent.challengeToken, "granted", "whatsapp_reply", {}, database);

    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    const rivalId = (await ProjectStore.findBySlug("rival", database))!.id;
    await DeviceStore.revokeConsent(device!.id, rivalId, "phone_holder", database);

    const bindings = await database.select().from(virtualDevices);
    expect(bindings.find((b) => b.environmentId === rivalProd)!.status).toBe("revoked");
    // Grande is untouched: revocation is scoped to the project that was revoked.
    expect(bindings.find((b) => b.environmentId === grandeProd)!.status).not.toBe("revoked");
  });

  test("a revoked project cannot re-grant itself by claiming again", async () => {
    // The predicate counted only granted and pending, so after a revocation the
    // device looked unclaimed, the next claim took the "new device" branch, and
    // grantImplicitConsent set the row back to granted — silently undoing an
    // explicit refusal by the phone holder.
    await claim(grandeProd, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await DeviceStore.revokeConsent(device!.id, grandeId, "phone_holder", database);

    const grandeOther = (await EnvironmentStore.create({ projectId: grandeId, slug: "other" }, database)).id;
    const again = await claim(grandeOther, "sneaky");

    // It may ask again — the customer might say yes this time — but it must
    // ask. Auto-granting is what the bug did.
    expect(again.outcome).toBe("awaiting_confirmation");
    expect((await DeviceStore.consentFor(device!.id, grandeId, database))!.status).toBe("pending");

    // And the revocation stays on the record regardless of what happens next.
    const trail = await database.select().from(consentEvents);
    expect(trail.some((e) => e.action === "revoked")).toBe(true);
  });

  test("a different project cannot inherit a revoked device either", async () => {
    await claim(grandeProd, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await DeviceStore.revokeConsent(device!.id, grandeId, "phone_holder", database);

    const rival = await claim(rivalProd, "theirs");
    // Must ask, not assume the device is free because nobody currently holds it.
    expect(rival.outcome).toBe("awaiting_confirmation");
  });

  test("every decision is written to an immutable trail with its evidence", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    await DeviceStore.respondToConsent(rival.consent.challengeToken, "granted", "whatsapp_reply", {
      replyingJid: "628123456789@s.whatsapp.net",
      messageId: "ABC123",
    }, database);

    const trail = await database.select().from(consentEvents);
    const granted = trail.find((e) => e.action === "granted" && e.actor === "phone_holder");
    // "Prove this customer agreed" needs the message id of their reply, not a boolean.
    expect(granted!.evidence["messageId"]).toBe("ABC123");
    expect(trail.some((e) => e.action === "requested")).toBe(true);
  });
});

describe("findings from review", () => {
  test("a revoked binding is not reactivated by a later consent grant", async () => {
    // activateBindingsFor updated every binding for the project, so a binding
    // the phone holder had specifically revoked came back when an unrelated
    // environment's consent was granted.
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    await DeviceStore.respondToConsent(rival.consent.challengeToken, "granted", "whatsapp_reply", {}, database);

    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    const rivalId = (await ProjectStore.findBySlug("rival", database))!.id;
    await DeviceStore.revokeConsent(device!.id, rivalId, "phone_holder", database);

    // A fresh environment asks again and is granted; the revoked binding must
    // stay revoked rather than riding along.
    const rivalStaging = (await EnvironmentStore.create({ projectId: rivalId, slug: "staging" }, database)).id;
    const again = await claim(rivalStaging, "second");
    if (again.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    await DeviceStore.respondToConsent(again.consent.challengeToken, "granted", "whatsapp_reply", {}, database);

    const bindings = await database.select().from(virtualDevices);
    expect(bindings.find((b) => b.environmentId === rivalProd)!.status).toBe("revoked");
    expect(bindings.find((b) => b.environmentId === rivalStaging)!.status).toBe("active");
  });

  test("re-opening a request clears the previous answer", async () => {
    // A pending row carrying the last decision's timestamp and evidence reads,
    // in the audit trail, as though the customer had already replied.
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    await DeviceStore.respondToConsent(rival.consent.challengeToken, "denied", "whatsapp_reply", { note: "no" }, database);

    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    const rivalId = (await ProjectStore.findBySlug("rival", database))!.id;
    const rivalStaging = (await EnvironmentStore.create({ projectId: rivalId, slug: "staging" }, database)).id;
    await claim(rivalStaging, "again");

    const consent = await DeviceStore.consentFor(device!.id, rivalId, database);
    expect(consent!.status).toBe("pending");
    expect(consent!.respondedAt).toBeNull();
    expect(consent!.responseChannel).toBeNull();
    expect(consent!.evidence).toEqual({});
  });
});

describe("consent expiry", () => {
  test("a granted consent does not lapse with its expiresAt", async () => {
    // The `granted → active` row read status alone. Both grant paths write an
    // expiresAt and nothing transitions a granted row, so a grant older than
    // 24 hours still read as granted while its own row claimed otherwise —
    // the table was right and the code disagreed with it.
    await claim(grandeProd, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await database
      .update(deviceConsents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(deviceConsents.deviceId, device!.id));

    const grandeOther = (await EnvironmentStore.create({ projectId: grandeId, slug: "other" }, database)).id;
    const again = await claim(grandeOther, "second");
    // Consent is revoked, not expired: the grant stands.
    expect(again.outcome).toBe("active");
  });

  test("a pending request does lapse", async () => {
    await claim(grandeProd, "otp-sender");
    const rival = await claim(rivalProd, "theirs");
    if (rival.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");

    await database
      .update(deviceConsents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(deviceConsents.id, rival.consent.id));

    // The question lapsed, so a fresh one is asked rather than the stale token
    // being reused.
    const rivalStaging = (await EnvironmentStore.create(
      { projectId: (await ProjectStore.findBySlug("rival", database))!.id, slug: "staging" },
      database,
    )).id;
    const again = await claim(rivalStaging, "again");
    if (again.outcome !== "awaiting_confirmation") throw new Error("expected a challenge");
    expect(again.consent.challengeToken).not.toBe(rival.consent.challengeToken);
  });
});

describe("binding rules", () => {
  test("an environment cannot bind the same number twice", async () => {
    await claim(grandeProd, "otp-sender");
    await expect(claim(grandeProd, "another-alias")).rejects.toThrow(ConflictError);
  });

  test("bindingsFor shows every project using a device", async () => {
    await claim(grandeProd, "otp-sender");
    await claim(rivalProd, "theirs");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    // The operator screen that makes sharing auditable.
    expect(await DeviceStore.bindingsFor(device!.id, database)).toHaveLength(2);
  });
});
