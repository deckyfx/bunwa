/**
 * Devices and the claim flow.
 *
 * The claim is the product. A customer who has already paired their number for
 * one project should not scan anything for the second, and a project that has
 * never been consented to should not get access by knowing a phone number.
 * Those two sentences are the whole design, and `claim()` below is where they
 * are enforced.
 */
import { and, eq } from "drizzle-orm";

import { db, type Database } from "../db";
import {
  consentEvents,
  deviceConsents,
  devices,
  environments,
  virtualDevices,
  type Device,
  type DeviceConsent,
  type VirtualDevice,
} from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

/** How long a phone holder has to answer before the request lapses. */
export const CONSENT_TTL_MS = 24 * 60 * 60 * 1000;

/** E.164: a leading +, then 8–15 digits. Normalised before storage. */
const MSISDN_PATTERN = /^\+[1-9]\d{7,14}$/;

export type ClaimOutcome =
  /** Nobody has paired this number. The customer scans once. */
  | { outcome: "pending_pairing"; virtualDevice: VirtualDevice; device: Device }
  /** This project already has consent. Nothing is asked of anyone. */
  | { outcome: "active"; virtualDevice: VirtualDevice; device: Device }
  /** Another project holds it. The phone holder is asked to confirm reuse. */
  | { outcome: "awaiting_confirmation"; virtualDevice: VirtualDevice; device: Device; consent: DeviceConsent };

export class DeviceStore {
  /**
   * Normalise a phone number, or reject it.
   *
   * Stored in one form only: the same number written two ways must not become
   * two devices, or the "already paired?" lookup silently stops working.
   */
  static normaliseMsisdn(raw: string): string {
    const trimmed = raw.trim().replace(/[\s()\-.]/g, "");
    const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
    if (!MSISDN_PATTERN.test(withPlus)) {
      throw new ValidationError(`"${raw}" is not a valid E.164 phone number`, "msisdn");
    }
    return withPlus;
  }

  /**
   * Bind an environment to a phone number, asking for consent if needed.
   *
   * @throws ConflictError if this environment already has a binding for it
   */
  static async claim(
    input: { environmentId: string; msisdn: string; alias: string; scopes?: string[] },
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<ClaimOutcome> {
    // Atomic: the flow writes a device, a consent, an audit row and a binding.
    // A failure partway through — a unique-constraint clash on the binding, say
    // — would otherwise leave the consent committed, and the retry would then
    // see a granted consent and take the `active` path with no binding at all.
    return database.transaction(async (tx) => this.claimWithin(tx as unknown as Database, input, now));
  }

  private static async claimWithin(
    database: Database,
    input: { environmentId: string; msisdn: string; alias: string; scopes?: string[] },
    now: Date,
  ): Promise<ClaimOutcome> {
    const msisdn = this.normaliseMsisdn(input.msisdn);
    const alias = input.alias.trim();
    if (alias === "") throw new ValidationError("alias is required", "alias");

    const [environment] = await database
      .select()
      .from(environments)
      .where(eq(environments.id, input.environmentId))
      .limit(1);
    if (environment === undefined) throw new NotFoundError(`environment ${input.environmentId} not found`);

    const device = (await this.findByMsisdn(msisdn, database)) ?? (await this.provision(msisdn, database));

    const [existingBinding] = await database
      .select()
      .from(virtualDevices)
      .where(and(eq(virtualDevices.environmentId, environment.id), eq(virtualDevices.deviceId, device.id)))
      .limit(1);
    if (existingBinding !== undefined && existingBinding.status !== "revoked") {
      throw new ConflictError(`this environment is already bound to ${msisdn}`, "msisdn");
    }

    const consent = await this.consentFor(device.id, environment.projectId, database);
    const projectHasConsent = consent !== null && consent.status === "granted";

    // Whether any project has a claim on this device already.
    //
    // Keying the first branch on `device.state === "unpaired"` alone was wrong,
    // and the tests caught it: a device stays unpaired until an engine actually
    // pairs it, so a second project claiming the same number in that window
    // would also be treated as the first — granted implicit consent and access
    // with nobody asked. The question is not "has it paired?" but "has anyone
    // else already claimed it?".
    // Any standing claim at all, by anyone including this project.
    //
    // The rule is "is this device new to the system?", not "is it new to this
    // project" and not "has it paired". Both narrower forms were wrong and both
    // were caught by tests: keying on device state let a second project slip in
    // before pairing completed, and ignoring this project's own *pending*
    // request let its second environment grant itself what the first was still
    // waiting to be given.
    const claimed = await this.hasStandingClaim(device.id, database);

    // Genuinely new to the system: the customer scans once, and pairing implies
    // consent for the project that caused it — they chose to pair for it.
    if (!claimed) {
      await this.grantImplicitConsent(device.id, environment.projectId, environment.id, now, database);
      const virtualDevice = await this.bind(environment.id, device.id, alias, input.scopes ?? [], "pending_pairing", database);
      return { outcome: "pending_pairing", virtualDevice, device };
    }

    // Already consented to this project — including by a sibling environment,
    // because consent is per project. This is the branch the product exists for.
    if (projectHasConsent) {
      const virtualDevice = await this.bind(environment.id, device.id, alias, input.scopes ?? [], "active", database, now);
      return { outcome: "active", virtualDevice, device };
    }

    // Paired, but this project has never been granted it. Ask the phone holder.
    const pending = await this.requestConsent(device.id, environment.projectId, environment.id, now, database);
    const virtualDevice = await this.bind(environment.id, device.id, alias, input.scopes ?? [], "pending_consent", database);
    return { outcome: "awaiting_confirmation", virtualDevice, device, consent: pending };
  }

  static async findByMsisdn(msisdn: string, database: Database = db()): Promise<Device | null> {
    const [found] = await database.select().from(devices).where(eq(devices.msisdn, msisdn)).limit(1);
    return found ?? null;
  }

  private static async provision(msisdn: string, database: Database): Promise<Device> {
    const [created] = await database.insert(devices).values({ msisdn }).returning();
    if (created === undefined) throw new Error("insert returned no row");
    return created;
  }

  private static async bind(
    environmentId: string,
    deviceId: string,
    alias: string,
    scopes: string[],
    status: VirtualDevice["status"],
    database: Database,
    activatedAt?: Date,
  ): Promise<VirtualDevice> {
    const [created] = await database
      .insert(virtualDevices)
      .values({
        environmentId,
        deviceId,
        alias,
        scopes,
        status,
        ...(activatedAt === undefined ? {} : { activatedAt }),
      })
      .onConflictDoUpdate({
        target: [virtualDevices.environmentId, virtualDevices.deviceId],
        set: { alias, scopes, status, revokedAt: null, updatedAt: new Date() },
      })
      .returning();
    if (created === undefined) throw new Error("upsert returned no row");
    return created;
  }

  /**
   * Whether anyone currently holds or is seeking this device.
   *
   * A denied or expired request does not count: those left no standing claim,
   * and a device nobody currently holds should not be permanently frozen by an
   * abandoned request.
   */
  private static async hasStandingClaim(deviceId: string, database: Database): Promise<boolean> {
    const rows = await database
      .select({ status: deviceConsents.status })
      .from(deviceConsents)
      .where(eq(deviceConsents.deviceId, deviceId));
    // `revoked` and `denied` count. They are decisions the phone holder made,
    // not an absence of one — and excluding them meant the next claim took the
    // "new device" branch and re-granted implicit consent, silently undoing an
    // explicit refusal. Only `expired` is treated as no claim: nobody decided
    // anything, the question simply lapsed.
    return rows.some((r) => r.status !== "expired");
  }

  static async consentFor(
    deviceId: string,
    projectId: string,
    database: Database = db(),
  ): Promise<DeviceConsent | null> {
    const [found] = await database
      .select()
      .from(deviceConsents)
      .where(and(eq(deviceConsents.deviceId, deviceId), eq(deviceConsents.projectId, projectId)))
      .limit(1);
    return found ?? null;
  }

  /** Pairing for a project implies consent for it: they chose to pair. */
  private static async grantImplicitConsent(
    deviceId: string,
    projectId: string,
    environmentId: string,
    now: Date,
    database: Database,
  ): Promise<DeviceConsent> {
    const [created] = await database
      .insert(deviceConsents)
      .values({
        deviceId,
        projectId,
        status: "granted",
        requestedByEnvironmentId: environmentId,
        challengeToken: crypto.randomUUID(),
        respondedAt: now,
        responseChannel: "dashboard",
        evidence: { implicit: "granted by pairing for this project" },
        expiresAt: new Date(now.getTime() + CONSENT_TTL_MS),
      })
      // No upsert: an implicit grant must never overwrite a row. If one exists
      // it records a decision — including a refusal — and pairing for a
      // project is not consent to override it.
      .onConflictDoNothing()
      .returning();
    if (created === undefined) {
      const existing = await this.consentFor(deviceId, projectId, database);
      if (existing === null) throw new Error("insert returned no row");
      return existing;
    }
    await this.audit(created.id, "granted", "system", "system", { implicit: true }, database);
    return created;
  }

  private static async requestConsent(
    deviceId: string,
    projectId: string,
    environmentId: string,
    now: Date,
    database: Database,
  ): Promise<DeviceConsent> {
    // Reuse a live request rather than minting a new token.
    //
    // A second environment of the same project claiming the same number would
    // otherwise replace the challenge, invalidating a message the phone holder
    // may already be looking at — and sending them a second one for a decision
    // they have already been asked to make. Consent is per project, so one
    // outstanding question per project is the correct number.
    const existing = await this.consentFor(deviceId, projectId, database);
    if (existing !== null && existing.status === "pending" && existing.expiresAt.getTime() > now.getTime()) {
      return existing;
    }

    const values = {
      deviceId,
      projectId,
      status: "pending" as const,
      requestedByEnvironmentId: environmentId,
      challengeToken: crypto.randomUUID(),
      expiresAt: new Date(now.getTime() + CONSENT_TTL_MS),
      updatedAt: now,
    };
    const [created] = await database
      .insert(deviceConsents)
      .values(values)
      // A re-request after a denial or a lapse starts a fresh challenge rather
      // than resurrecting the old token, which may have been seen by then.
      .onConflictDoUpdate({ target: [deviceConsents.deviceId, deviceConsents.projectId], set: values })
      .returning();
    if (created === undefined) throw new Error("insert returned no row");
    await this.audit(created.id, "requested", "system", "system", { environmentId }, database);
    return created;
  }

  /**
   * Record the phone holder's answer.
   *
   * Granting activates every binding this project has for the device, in any
   * environment — consent is per project, so a sibling environment that was
   * waiting is released by the same answer.
   */
  static async respondToConsent(
    challengeToken: string,
    decision: "granted" | "denied",
    channel: "whatsapp_reply" | "dashboard" | "operator",
    evidence: Record<string, unknown> = {},
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<DeviceConsent> {
    // Atomic: the decision, its audit row and the bindings it releases must
    // land together, or a customer's "yes" is recorded with nothing activated.
    return database.transaction(async (tx) =>
      this.respondWithin(tx as unknown as Database, challengeToken, decision, channel, evidence, now),
    );
  }

  private static async respondWithin(
    database: Database,
    challengeToken: string,
    decision: "granted" | "denied",
    channel: "whatsapp_reply" | "dashboard" | "operator",
    evidence: Record<string, unknown>,
    now: Date,
  ): Promise<DeviceConsent> {
    const [consent] = await database
      .select()
      .from(deviceConsents)
      .where(eq(deviceConsents.challengeToken, challengeToken))
      .limit(1);
    if (consent === undefined) throw new NotFoundError("consent request not found");

    if (consent.status !== "pending") {
      throw new ConflictError(`this consent request is already ${consent.status}`);
    }
    if (consent.expiresAt.getTime() <= now.getTime()) {
      await database
        .update(deviceConsents)
        .set({ status: "expired", updatedAt: now })
        .where(eq(deviceConsents.id, consent.id));
      await this.audit(consent.id, "expired", "system", "system", {}, database);
      throw new ConflictError("this consent request has expired");
    }

    const [updated] = await database
      .update(deviceConsents)
      .set({ status: decision, respondedAt: now, responseChannel: channel, evidence, updatedAt: now })
      .where(eq(deviceConsents.id, consent.id))
      .returning();
    if (updated === undefined) throw new NotFoundError("consent request not found");

    await this.audit(updated.id, decision, "phone_holder", channel, evidence, database);

    if (decision === "granted") {
      await this.activateBindingsFor(updated.deviceId, updated.projectId, now, database);
    }
    return updated;
  }

  /**
   * Revoke a project's consent.
   *
   * Immediate, and scoped: the device's other projects are untouched.
   */
  static async revokeConsent(
    deviceId: string,
    projectId: string,
    actor: "phone_holder" | "operator",
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<void> {
    await database.transaction(async (tx) =>
      this.revokeWithin(tx as unknown as Database, deviceId, projectId, actor, now),
    );
  }

  private static async revokeWithin(
    database: Database,
    deviceId: string,
    projectId: string,
    actor: "phone_holder" | "operator",
    now: Date,
  ): Promise<void> {
    const consent = await this.consentFor(deviceId, projectId, database);
    if (consent === null) throw new NotFoundError("no consent to revoke");

    await database
      .update(deviceConsents)
      .set({ status: "revoked", updatedAt: now })
      .where(eq(deviceConsents.id, consent.id));
    await this.audit(consent.id, "revoked", actor, actor === "operator" ? "operator" : "dashboard", {}, database);

    const owned = await database
      .select({ id: virtualDevices.id })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(and(eq(virtualDevices.deviceId, deviceId), eq(environments.projectId, projectId)));

    for (const row of owned) {
      await database
        .update(virtualDevices)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(eq(virtualDevices.id, row.id));
    }
  }

  private static async activateBindingsFor(
    deviceId: string,
    projectId: string,
    now: Date,
    database: Database,
  ): Promise<void> {
    const waiting = await database
      .select({ id: virtualDevices.id })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(and(eq(virtualDevices.deviceId, deviceId), eq(environments.projectId, projectId)));

    for (const row of waiting) {
      await database
        .update(virtualDevices)
        .set({ status: "active", activatedAt: now, updatedAt: now })
        .where(eq(virtualDevices.id, row.id));
    }
  }

  /** Append to the immutable trail. Never updated, never deleted. */
  private static async audit(
    consentId: string,
    action: "requested" | "challenge_sent" | "granted" | "denied" | "revoked" | "expired",
    actor: "phone_holder" | "operator" | "system",
    channel: "whatsapp_reply" | "dashboard" | "operator" | "system",
    evidence: Record<string, unknown>,
    database: Database,
  ): Promise<void> {
    await database.insert(consentEvents).values({ consentId, action, actor, channel, evidence });
  }

  /**
   * This environment's bindings.
   *
   * Returns virtual devices, never the global device id: two projects sharing a
   * phone must not be able to correlate their traffic through a shared
   * identifier.
   */
  static async listForEnvironment(environmentId: string, database: Database = db()) {
    return database
      .select({
        virtualDeviceId: virtualDevices.id,
        alias: virtualDevices.alias,
        status: virtualDevices.status,
        scopes: virtualDevices.scopes,
        msisdn: devices.msisdn,
        deviceState: devices.state,
      })
      .from(virtualDevices)
      .innerJoin(devices, eq(virtualDevices.deviceId, devices.id))
      .where(eq(virtualDevices.environmentId, environmentId));
  }

  /** Everything using this device, for the operator "who can use my number" view. */
  static async bindingsFor(deviceId: string, database: Database = db()) {
    return database
      .select({ virtualDevice: virtualDevices, projectId: environments.projectId })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(eq(virtualDevices.deviceId, deviceId));
  }
}
