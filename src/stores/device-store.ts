/**
 * Devices and the claim flow.
 *
 * The claim is the product. A customer who has already paired their number for
 * one project should not scan anything for the second, and a project that has
 * never been consented to should not get access by knowing a phone number.
 * Those two sentences are the whole design, and `claim()` below is where they
 * are enforced.
 */
import { and, count as drizzleCount, eq, ne, or } from "drizzle-orm";
import type { EngineKind } from "../engine/types";

import { db, type Database } from "../db";
import { consentEvents, deviceConsents, devices, environments, projects, type Device, type DeviceConsent, type VirtualDevice, virtualDevices } from "../db/schema";
import { withTransaction } from "../db/transaction";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

/** How long a phone holder has to answer before the request lapses. */
export const CONSENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A consent's status, accounting for its expiry.
 *
 * `expiresAt` is the deadline for *answering a request*, and only ever that.
 * A granted consent carries none: it stands until the phone holder revokes it.
 * It is not a lifetime on the
 * answer: consent does not lapse, it is revoked. Reading `status` alone made
 * the `granted → active` row of the table below wrong, because both
 * requestConsent writes one, grantImplicitConsent does not, and nothing ever
 * transitions a granted row, so a grant older than 24 hours still read as
 * granted while its row claimed to have expired.
 *
 * So: only a *pending* request can lapse. Everything else means what it says.
 */
function effectiveStatus(
  consent: DeviceConsent | null,
  now: Date,
): "granted" | "pending" | "denied" | "revoked" | "expired" | "none" {
  if (consent === null) return "none";
  // Only a pending challenge lapses. A grant has no expiry — the column is
  // null for one — so a missing deadline means "does not expire", not "expired".
  if (consent.status === "pending" && consent.expiresAt !== null && consent.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return consent.status;
}

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
    return withTransaction(database, (tx) => this.claimWithin(tx, input, now));
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

    // Refused rather than queued. The number is mid-retirement: its credentials
    // are being destroyed, so a binding made now would be attached to a session
    // that is about to stop existing, and the tenant would be left with a
    // device that had failed for reasons nothing in their project explains.
    // Retirement is short and terminal, so the honest answer is "not this one,
    // not now".
    if (device.state === "retiring") {
      throw new ConflictError(`${msisdn} is being retired; claim it again once that finishes`, "msisdn");
    }

    const [existingBinding] = await database
      .select()
      .from(virtualDevices)
      .where(and(eq(virtualDevices.environmentId, environment.id), eq(virtualDevices.deviceId, device.id)))
      .limit(1);
    if (existingBinding !== undefined && existingBinding.status !== "revoked") {
      throw new ConflictError(`this environment is already bound to ${msisdn}`, "msisdn");
    }

    /*
     * The consent state machine, enumerated.
     *
     * This is the fourth pass finding a bug here, and every previous fix
     * handled whichever combination a reviewer had surfaced — device state,
     * then other-project consent, then this project's pending request, then a
     * revoked one. Each was correct and each left the next case open. So the
     * table below is exhaustive over (this project's consent × any other
     * standing claim), and every row is a deliberate decision rather than a
     * fallthrough:
     *
     *   this project    others hold?   outcome
     *   ─────────────────────────────────────────────────────────────────
     *   granted         any            active — the product's whole point
     *                                    (a grant does not lapse; only a
     *                                     pending request can expire)
     *   pending         any            awaiting (reuse the live challenge)
     *   denied          any            awaiting (they may say yes now)
     *   revoked         any            awaiting (they may say yes now)
     *   expired         yes            awaiting — someone else holds it
     *   expired         no             new device: pair, implicit consent
     *   none            yes            awaiting — someone else holds it
     *   none            no             new device: pair, implicit consent
     */
    const consent = await this.consentFor(device.id, environment.projectId, database);
    const mine = effectiveStatus(consent, now);

    if (mine === "granted") {
      const virtualDevice = await this.bind(environment.id, device.id, alias, input.scopes ?? [], "active", database, now);
      return { outcome: "active", virtualDevice, device };
    }

    // Only "expired" and "none" can reach the new-device branch, and only when
    // nobody else holds the device. Everything else is a decision that has been
    // made, or a question already outstanding, and must be asked rather than
    // assumed.
    const undecided = mine === "expired" || mine === "none";
    const claimedByAnyone = await this.hasStandingClaim(device.id, database, now);

    if (undecided && !claimedByAnyone) {
      // Genuinely new to the system. The customer scans once, and pairing for
      // a project is consent for it — they chose to pair for this product.
      await this.grantImplicitConsent(device.id, environment.projectId, environment.id, now, database);
      const virtualDevice = await this.bind(
        environment.id,
        device.id,
        alias,
        input.scopes ?? [],
        "pending_pairing",
        database,
      );
      return { outcome: "pending_pairing", virtualDevice, device };
    }

    // Everything else asks. A pending request is reused rather than replaced,
    // so a second environment does not invalidate a challenge the phone holder
    // may already be looking at.
    const pending = await this.requestConsent(device.id, environment.projectId, environment.id, now, database);
    const virtualDevice = await this.bind(
      environment.id,
      device.id,
      alias,
      input.scopes ?? [],
      "pending_consent",
      database,
    );
    return { outcome: "awaiting_confirmation", virtualDevice, device, consent: pending };
  }

  /** @crossTenant Devices are system-owned and keyed by a global number. */
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
   * Whether any decision has been made about this device.
   *
   * `granted`, `pending`, `denied` and `revoked` all count — a refusal is a
   * decision, and treating it as an absence is what let a revoked project
   * re-grant itself. Only `expired` does not: nobody decided anything, the
   * question simply lapsed, so the device is genuinely unclaimed again.
   */
  private static async hasStandingClaim(deviceId: string, database: Database, now: Date): Promise<boolean> {
    const rows = await database
      .select()
      .from(deviceConsents)
      .where(eq(deviceConsents.deviceId, deviceId));
    // `revoked` and `denied` count. They are decisions the phone holder made,
    // not an absence of one — and excluding them meant the next claim took the
    // "new device" branch and re-granted implicit consent, silently undoing an
    // explicit refusal. Only `expired` is treated as no claim: nobody decided
    // anything, the question simply lapsed.
    // Compared through effectiveStatus, not the persisted column. A pending
    // request whose deadline has passed is `expired` in the table above but
    // still reads "pending" in its row, so comparing the column directly made
    // the "expired + no other claim" row unreachable — a device nobody ever
    // answered for stayed claimed for ever.
    return rows.some((r) => effectiveStatus(r, now) !== "expired");
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
        // No deadline on a grant — the insert branch, matching the update
        // branch below. Setting one here is how every implicitly-granted
        // consent silently lapsed after 24 hours.
        expiresAt: null,
      })
      // Upserts only over an expired row. onConflictDoNothing left a stale
      // `expired` consent in place while pairing proceeded, so the device
      // ended up paired for a project whose consent said it had lapsed — and
      // no audit row was written either. A decision (granted, denied, revoked)
      // is never reached here: the caller has already excluded those.
      .onConflictDoUpdate({
        target: [deviceConsents.deviceId, deviceConsents.projectId],
        set: {
          status: "granted",
          respondedAt: now,
          responseChannel: "dashboard",
          requestedByEnvironmentId: environmentId,
          // No expiry on a grant. The TTL belongs to the *question*, not the
          // answer: a challenge lapses if nobody replies, but a consent the
          // phone holder gave stands until they revoke it. Writing an expiry
          // here meant every granted consent silently lapsed after 24 hours and
          // the project had to ask again.
          expiresAt: null,
          // Rotated, not cleared — the column is not nullable. The effect is
          // what matters: any challenge the phone holder still holds stops
          // working, and respondWithin rejects a non-pending row anyway, so
          // the new token cannot be answered either.
          challengeToken: crypto.randomUUID(),
          evidence: { implicit: "granted by pairing for this project" },
          updatedAt: now,
        },
      })
      .returning();
    if (created === undefined) throw new Error("upsert returned no row");
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
    // A pending row with no deadline cannot happen — requestConsent always
    // sets one — but reading it as still-live is the safe interpretation:
    // reusing an outstanding question beats issuing a second challenge to a
    // phone holder who is already looking at one.
    const stillLive = existing?.expiresAt === null || (existing?.expiresAt?.getTime() ?? 0) > now.getTime();
    if (existing !== null && existing.status === "pending" && stillLive) {
      return existing;
    }

    const values = {
      deviceId,
      projectId,
      status: "pending" as const,
      requestedByEnvironmentId: environmentId,
      challengeToken: crypto.randomUUID(),
      expiresAt: new Date(now.getTime() + CONSENT_TTL_MS),
      // Cleared: a re-opened request carrying the previous answer's timestamp
      // and evidence would read, in the audit trail, as though the customer had
      // already replied to a question that is still outstanding.
      respondedAt: null,
      responseChannel: null,
      evidence: {},
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
    return withTransaction(database, (tx) =>
      this.respondWithin(tx, challengeToken, decision, channel, evidence, now),
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
    if (consent.expiresAt !== null && consent.expiresAt.getTime() <= now.getTime()) {
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
    await withTransaction(database, (tx) => this.revokeWithin(tx, deviceId, projectId, actor, now));
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

  /**
   * Which projects still have a live claim on this device.
   *
   * The question this exists for: when one project lets a shared number go, is
   * anyone else still using it? If so the device carries on and only that
   * project's binding ends; if not there is nothing left the credentials serve.
   *
   * Answered from the consent record, not from the binding alone. A binding is
   * created `pending_consent` and is only ever moved off that by a grant — a
   * denial and a lapsed deadline both leave it exactly as it was. Counting
   * bindings therefore counted projects the phone holder had refused, so the
   * last project that actually had consent could release a number and find it
   * not retired: credentials and message history kept alive on behalf of
   * someone who had been told no.
   *
   * Granted holds, and so does pending — a request still inside its deadline
   * is a decision outstanding, and retiring the device underneath it would
   * answer the question by destroying what it was about. Denied, revoked and
   * expired hold nothing; the project has no access and no question pending.
   *
   * Deliberately not the same rule as `hasStandingClaim`, which counts denied
   * and revoked *because* they are decisions — it is asking whether anyone has
   * ever answered for this device, so that a new claim cannot silently re-grant
   * itself past a refusal. This asks who would lose something if the number
   * went away, and a project holding a refusal loses nothing.
   *
   * A suspended binding still counts when its consent is live: that is a
   * tenant whose access is paused rather than ended, and unlinking the number
   * from WhatsApp underneath them would be the wrong answer.
   */
  static async projectsHolding(
    deviceId: string,
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<string[]> {
    const rows = await database
      .selectDistinct({ projectId: environments.projectId })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(and(eq(virtualDevices.deviceId, deviceId), ne(virtualDevices.status, "revoked")));

    const holding: string[] = [];
    for (const row of rows) {
      const consent = await this.consentFor(deviceId, row.projectId, database);
      const status = effectiveStatus(consent, now);
      if (status === "granted" || status === "pending") holding.push(row.projectId);
    }

    return holding;
  }

  /**
   * Revoke one project's claim, and reserve the device if it was the last.
   *
   * The decision and the reservation are one transaction because they are one
   * decision. Asked separately, another project could claim the number between
   * "nobody holds this" and the credentials being destroyed: its binding would
   * be created against a live session that was about to be logged out, and the
   * tenant would be left holding a device that had silently stopped working
   * for reasons nothing in their project explained.
   *
   * `retiring` is a reservation rather than a state of the phone, which is why
   * `claim` refuses it: the caller has committed to destroying this device and
   * has not finished yet.
   *
   * @returns the projects still holding it. Empty means the caller reserved it
   * and must now retire it or release the reservation.
   */
  static async releaseFor(
    deviceId: string,
    projectId: string,
    actor: "phone_holder" | "operator",
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<string[]> {
    return withTransaction(database, async (tx) => {
      await this.revokeWithin(tx, deviceId, projectId, actor, now);

      // Asked after the revocation, not before. Before, this project's own
      // claim would still count and nothing would ever be the last one.
      const holders = await this.projectsHolding(deviceId, tx, now);
      if (holders.length === 0) await this.reserveWithin(tx, deviceId, now);
      return holders;
    });
  }

  /**
   * Revoke every project's claim and reserve the device, for an operator.
   *
   * The same transaction for the same reason. An operator retiring a device
   * says the number is finished, so unlike `releaseFor` there is no holder
   * count to consult — but the window between revoking the last binding and
   * destroying the credentials is identical, and a claim landing in it would
   * bind a tenant to a session already condemned.
   *
   * @returns the projects whose claims were ended.
   */
  static async retireFor(
    deviceId: string,
    actor: "phone_holder" | "operator",
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<string[]> {
    return withTransaction(database, async (tx) => {
      // Checked before anything else. Without it an unknown id was a silent
      // success: nothing to revoke, an update touching no rows, and a
      // retirement finding no device to end — so a mistyped id answered 200
      // "retired" and the operator was told a number had been destroyed that
      // had never existed. The tenant route already 404s for the same mistake.
      const [device] = await tx
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (device === undefined) throw new NotFoundError(`device ${deviceId} not found`);

      // Every project with a binding, not every project that *holds* it.
      // `projectsHolding` answers a narrower question — who would lose
      // something — and deliberately excludes projects whose consent was
      // denied or has lapsed. Those still have a binding row, and revoking by
      // holder left it behind pointing at a device whose credentials had just
      // been destroyed.
      const bound = await this.projectsBound(deviceId, tx);
      for (const projectId of bound) {
        await this.revokeWithin(tx, deviceId, projectId, actor, now);
      }
      await this.reserveWithin(tx, deviceId, now);
      return bound;
    });
  }

  /**
   * Every project with a binding to this device that has not been revoked.
   *
   * The structural question, where `projectsHolding` asks the consent one.
   * Kept apart because they diverge exactly where it matters: a refused
   * project is bound but holds nothing, so it must not block a retirement and
   * must still be cleaned up by one.
   */
  private static async projectsBound(deviceId: string, database: Database): Promise<string[]> {
    const rows = await database
      .selectDistinct({ projectId: environments.projectId })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(and(eq(virtualDevices.deviceId, deviceId), ne(virtualDevices.status, "revoked")));

    return rows.map((row) => row.projectId);
  }

  /** Take the reservation. Separate only so both paths above set it identically. */
  private static async reserveWithin(database: Database, deviceId: string, now: Date): Promise<void> {
    await database
      .update(devices)
      .set({
        state: "retiring",
        stateReason: "retiring: the last claim ended and the credentials are being destroyed",
        updatedAt: now,
      })
      .where(eq(devices.id, deviceId));
  }

  /**
   * Give the reservation back, when the retirement it was taken for failed.
   *
   * Without this a device whose retirement threw would sit in `retiring` for
   * ever, refusing every future claim with an explanation that had stopped
   * being true — the number unusable by anyone, including the project that
   * still held it.
   */
  static async cancelRetirement(
    deviceId: string,
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<void> {
    await database
      .update(devices)
      .set({
        state: "disconnected",
        stateReason: "retirement failed; the device was left as it was",
        updatedAt: now,
      })
      .where(and(eq(devices.id, deviceId), eq(devices.state, "retiring")));
  }

  /**
   * Mark a device as holding no session, after its credentials have gone.
   *
   * Separate from the engine work so the row and the socket cannot disagree
   * about what happened: the caller ends the session first and records it
   * here, rather than this method implying anything about a live connection.
   */
  static async markRetired(deviceId: string, database: Database = db(), now: Date = new Date()): Promise<void> {
    await database
      .update(devices)
      .set({
        state: "unpaired",
        stateReason: "retired: credentials destroyed, the device must pair again",
        enginePoolId: null,
        engineDeviceId: null,
        jid: null,
        updatedAt: now,
      })
      .where(eq(devices.id, deviceId));
  }

  private static async activateBindingsFor(
    deviceId: string,
    projectId: string,
    now: Date,
    database: Database,
  ): Promise<void> {
    const waiting = await database
      .select({ id: virtualDevices.id, status: virtualDevices.status })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(and(eq(virtualDevices.deviceId, deviceId), eq(environments.projectId, projectId)));

    for (const row of waiting) {
      // Only bindings that were waiting on this answer. A revoked binding was
      // deliberately taken away, and a later consent grant elsewhere in the
      // project must not quietly restore it; a suspended one is an operator
      // decision that consent does not override either.
      if (row.status !== "pending_consent" && row.status !== "pending_pairing") continue;
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
  /**
   * One binding in this environment, by id or alias.
   *
   * Environment-scoped and matched on either identifier, because a project
   * addresses its devices by the alias it chose — the id is bunwa's, the alias
   * is theirs, and both must resolve to the same row without ever crossing a
   * tenant boundary.
   */
  static async findBinding(environmentId: string, ref: string, database: Database = db()) {
    const [found] = await database
      .select({ virtualDevice: virtualDevices, device: devices })
      .from(virtualDevices)
      .innerJoin(devices, eq(virtualDevices.deviceId, devices.id))
      .where(
        and(
          eq(virtualDevices.environmentId, environmentId),
          or(eq(virtualDevices.id, ref), eq(virtualDevices.alias, ref)),
        ),
      )
      .limit(1);
    return found ?? null;
  }

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

  /**
   * Every device on the instance, with who is using it.
   *
   * The operator's view, and the one thing a project key can never assemble:
   * a number can be shared, so "which tenants does this device serve?" is a
   * question only somebody outside all of them can ask. It is also the
   * question that decides whether retiring a device is a small act or a large
   * one.
   *
   * The msisdn is included because for an operator it *is* the device's name —
   * ids identify, phone numbers are what a support conversation is about.
   */
  static async listAll(database: Database = db()) {
    const rows = await database
      .select({
        deviceId: devices.id,
        msisdn: devices.msisdn,
        state: devices.state,
        stateReason: devices.stateReason,
        lastSeenAt: devices.lastSeenAt,
        enginePoolId: devices.enginePoolId,
        bindingStatus: virtualDevices.status,
        alias: virtualDevices.alias,
        projectId: projects.id,
        projectName: projects.displayName,
        environmentSlug: environments.slug,
      })
      .from(devices)
      .leftJoin(virtualDevices, eq(virtualDevices.deviceId, devices.id))
      .leftJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .leftJoin(projects, eq(environments.projectId, projects.id));

    // Folded here rather than in the query: one row per device with its
    // holders nested is what the screen renders, and a join returns one row
    // per binding. Doing it in SQL would mean string-aggregating names, which
    // is harder to read and no faster at this size.
    const byDevice = new Map<string, {
      deviceId: string;
      msisdn: string;
      state: string;
      stateReason: string | null;
      lastSeenAt: Date | null;
      enginePoolId: string | null;
      heldBy: Array<{ projectId: string; projectName: string; environmentSlug: string; alias: string; status: string }>;
    }>();

    for (const row of rows) {
      const existing = byDevice.get(row.deviceId) ?? {
        deviceId: row.deviceId,
        msisdn: row.msisdn,
        state: row.state,
        stateReason: row.stateReason,
        lastSeenAt: row.lastSeenAt,
        enginePoolId: row.enginePoolId,
        heldBy: [],
      };

      // A revoked binding is a project that used to hold this number. Listing
      // it as a holder would make a device look shared when it is not, and
      // that is the number the retire decision turns on.
      if (
        row.projectId !== null &&
        row.projectName !== null &&
        row.environmentSlug !== null &&
        row.alias !== null &&
        row.bindingStatus !== null &&
        row.bindingStatus !== "revoked"
      ) {
        existing.heldBy.push({
          projectId: row.projectId,
          projectName: row.projectName,
          environmentSlug: row.environmentSlug,
          alias: row.alias,
          status: row.bindingStatus,
        });
      }

      byDevice.set(row.deviceId, existing);
    }

    return [...byDevice.values()];
  }

  /**
   * How many devices each engine pool currently holds.
   *
   * Counted from the rows rather than kept in the registry: an in-memory tally
   * drifts from the database on any restart or concurrent write, and a pool
   * that looks empty while it is full is exactly the failure bounded capacity
   * exists to prevent.
   */
  /** @crossTenant Capacity is a property of a pool, not of a tenant. */
  static async countByPool(database: Database = db()): Promise<Map<string, number>> {
    const rows = await database
      .select({ poolId: devices.enginePoolId, count: drizzleCount() })
      .from(devices)
      .groupBy(devices.enginePoolId);
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.poolId !== null) counts.set(row.poolId, Number(row.count));
    }
    return counts;
  }

  /**
   * Record which engine pool holds a device.
   *
   * Nothing wrote enginePoolId, so countByPool saw every device as unassigned,
   * choosePool always read zero usage, and the bounded capacity that
   * ADR-0003 rests on had no effect whatsoever.
   */
  static async assignPool(
    deviceId: string,
    poolId: string,
    engineKind: EngineKind,
    engineDeviceId: string,
    database: Database = db(),
  ): Promise<void> {
    await database
      .update(devices)
      .set({ enginePoolId: poolId, engineKind, engineDeviceId, updatedAt: new Date() })
      .where(eq(devices.id, deviceId));
  }

  /** Which pool holds a device, or null if it has not been provisioned yet. */
  /** @crossTenant Resolves which engine holds a device, before any tenant is known. */
  static async poolIdFor(deviceId: string, database: Database = db()): Promise<string | null> {
    const [row] = await database
      .select({ poolId: devices.enginePoolId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    return row?.poolId ?? null;
  }

  /** Everything using this device, for the operator "who can use my number" view. */
  /**
   * Every binding on a device, for the operator "who can use my number" view.
   *
   * Intentionally cross-tenant and therefore **operator-only**: it is the
   * screen that makes device sharing auditable, and it must never be reachable
   * from a project-scoped route.
   */
  static async bindingsFor(deviceId: string, database: Database = db()) {
    return database
      .select({ virtualDevice: virtualDevices, projectId: environments.projectId })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(eq(virtualDevices.deviceId, deviceId));
  }
}
