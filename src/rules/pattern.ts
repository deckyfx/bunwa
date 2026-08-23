/**
 * Safe pattern matching for tenant-supplied regexes.
 *
 * Rules are written by projects and run against every inbound message, so a
 * catastrophically backtracking pattern is a denial of service against every
 * other tenant on the node — not just the one who wrote it.
 *
 * Three mitigations, all of them necessary:
 *
 *  1. **RE2 semantics only.** No backreferences, no lookaround. Those are the
 *     constructs that make matching super-linear; forbidding them is a
 *     structural guarantee rather than a hope.
 *  2. **Compiled and bounded at save time**, so an unsafe pattern is rejected
 *     when a human is present to see the error, not at 3am against real traffic.
 *  3. **A hard timeout at execution**, because JavaScript's engine is not RE2
 *     and (1) is enforced by inspection rather than by the runtime.
 */
import { ValidationError } from "../stores/errors";

/** Longest pattern accepted. Long patterns are rarely intentional. */
export const MAX_PATTERN_LENGTH = 512;

/** How long a single match may take before the rule is abandoned. */
export const MATCH_TIMEOUT_MS = 50;

/**
 * Constructs RE2 does not support, which are also the ones that backtrack.
 *
 * Matched on the pattern text rather than a parse tree: crude, but it errs
 * toward rejection, and a tenant who genuinely needs lookahead can be told no.
 */
const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\(\?=/, reason: "lookahead" },
  { pattern: /\(\?!/, reason: "negative lookahead" },
  { pattern: /\(\?<=/, reason: "lookbehind" },
  { pattern: /\(\?<!/, reason: "negative lookbehind" },
  { pattern: /\\[1-9]/, reason: "backreference" },
  { pattern: /\\k</, reason: "named backreference" },
];

/**
 * Nested quantifiers — `(a+)+`, `(a*)*` — the classic catastrophic shape.
 *
 * RE2 handles these in linear time; JavaScript does not, and since the engine
 * here is JavaScript the shape is refused outright.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*]\)[+*]/;

export interface CompiledPattern {
  source: string;
  regex: RegExp;
}

/**
 * Validate and compile a tenant pattern.
 *
 * @throws ValidationError with the specific construct named, so the author can
 * fix it rather than guess
 */
export function compilePattern(source: string, field = "pattern"): CompiledPattern {
  if (source.length === 0) throw new ValidationError("pattern is empty", field);
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new ValidationError(`pattern must be at most ${MAX_PATTERN_LENGTH} characters`, field);
  }

  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(source)) {
      throw new ValidationError(`pattern uses ${reason}, which is not supported (RE2 syntax only)`, field);
    }
  }
  if (NESTED_QUANTIFIER.test(source)) {
    throw new ValidationError("pattern nests quantifiers, which can take exponential time", field);
  }

  let regex: RegExp;
  try {
    // No global flag: a stateful lastIndex across calls makes a rule match
    // intermittently, which is close to impossible to debug from the outside.
    regex = new RegExp(source, "u");
  } catch (err) {
    throw new ValidationError(`pattern is not valid: ${err instanceof Error ? err.message : String(err)}`, field);
  }

  return { source, regex };
}

export interface MatchResult {
  matched: boolean;
  /** Named capture groups, available to actions as `match.<name>`. */
  captures: Record<string, string>;
  /** True when the match was abandoned; the rule is treated as not matching. */
  timedOut: boolean;
}

/**
 * Run a compiled pattern against a value under a time budget.
 *
 * The budget is checked after the fact rather than interrupting the match:
 * JavaScript cannot pre-empt a running regex. It therefore does not prevent one
 * slow match, but it detects it — and the caller disables a rule that keeps
 * exceeding it, so one bad pattern degrades one rule rather than the node.
 */
export function runMatch(compiled: CompiledPattern, value: string, timeoutMs = MATCH_TIMEOUT_MS): MatchResult {
  const began = performance.now();
  const result = compiled.regex.exec(value);
  const elapsed = performance.now() - began;

  if (elapsed > timeoutMs) {
    return { matched: false, captures: {}, timedOut: true };
  }
  if (result === null) return { matched: false, captures: {}, timedOut: false };

  return { matched: true, captures: { ...(result.groups ?? {}) }, timedOut: false };
}
