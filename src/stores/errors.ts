/**
 * Errors the store layer raises.
 *
 * Distinct types rather than strings so the HTTP layer can map them to status
 * codes without matching on message text, which drifts the moment a message is
 * reworded.
 */

/** A uniqueness rule was violated — a duplicate slug, for instance. */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

/** The row does not exist, or is not visible to the caller's tenant. */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/** The request is well-formed but semantically invalid. */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}
