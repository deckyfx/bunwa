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
 *  3. **A bounded subject and a time budget at execution**, because
 *     JavaScript's engine is not RE2 and (1) is enforced by inspection rather
 *     than by the runtime.
 *
 * **Known limit.** Static analysis of a regex cannot be complete, and JavaScript
 * cannot pre-empt a running match, so the budget below *detects* a slow match
 * rather than preventing it — one pathological pattern can still occupy the
 * event loop once. Truncating the subject bounds how badly. Terminating a match
 * properly needs it to run in a worker that can be killed, which is real work
 * and is tracked in docs/08 under stage 2 rather than half-done here.
 */
import { ValidationError } from "../stores/errors";

/** Longest pattern accepted. Long patterns are rarely intentional. */
export const MAX_PATTERN_LENGTH = 512;

/** How long a single match may take before the rule is abandoned. */
export const MATCH_TIMEOUT_MS = 50;

/**
 * Longest subject a pattern is run against.
 *
 * Backtracking blowup grows with input length, so bounding the input bounds
 * the worst case even for a pattern the checks above did not catch. A message
 * body longer than this is truncated for matching only — the message itself is
 * untouched.
 */
export const MAX_SUBJECT_LENGTH = 4096;

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
 * Whether any quantified group itself contains a quantifier.
 *
 * `(a+)+`, `(a{1,})+`, `((a+)b)+` — the shapes where each extra character can
 * double the work. RE2 handles them in linear time; JavaScript does not, and
 * the engine here is JavaScript.
 *
 * Scanned with a paren counter rather than matched with a regex. A regex over
 * regexes cannot see balanced groups, and the version that tried missed
 * `((a+)b)+` entirely: the quantifier sits inside the *nested* group, so no
 * fixed pattern lines it up with the outer one.
 */
function hasNestedQuantifier(source: string): boolean {
  const starts: number[] = [];

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++; // escaped: consume the pair
      continue;
    }
    if (char === "[") {
      // Character class: quantifiers inside are literal.
      while (i < source.length && source[i] !== "]") {
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (char === "(") {
      starts.push(i);
      continue;
    }
    if (char !== ")") continue;

    const open = starts.pop();
    if (open === undefined) continue; // unbalanced; the compile below rejects it

    if (!isQuantifier(source, i + 1)) continue;

    const body = source.slice(open + 1, i);
    // The group is quantified. Two shapes inside it can backtrack
    // catastrophically:
    //
    //  - another quantifier: (a+)+
    //  - an alternation whose branches can match the same text: (a|aa)+
    //
    // Deciding whether branches genuinely overlap needs real analysis, so any
    // quantified alternation is refused. Conservative, and an author who wants
    // `(foo|bar)+` can write `(?:foo|bar)` inside a character class or repeat
    // the group differently. Refusing a safe pattern costs an error message;
    // accepting an unsafe one costs the node.
    if (containsQuantifier(body)) return true;
    if (containsAlternation(body)) return true;
  }

  return false;
}

/** Whether a quantifier begins at `index`: +, *, or {n,m}. */
function isQuantifier(source: string, index: number): boolean {
  const char = source[index];
  if (char === "+" || char === "*") return true;
  if (char !== "{") return false;
  return /^\{\d+(?:,\d*)?\}/.test(source.slice(index));
}

/** Whether a group body contains a top-level alternation. */
function containsAlternation(body: string): boolean {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "[") {
      while (i < body.length && body[i] !== "]") {
        if (body[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * Whether a group body quantifies anything, ignoring escapes and classes.
 *
 * `?` counts here but deliberately not in `isQuantifier`. `(a?)+` backtracks
 * like `(a*)+` because the optional branch lets the same input be split many
 * ways — but a group merely *made* optional, `(ab)?`, repeats nothing and is
 * safe. The distinction is which side of the group the `?` sits on.
 */
function containsQuantifier(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "[") {
      while (i < body.length && body[i] !== "]") {
        if (body[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (isQuantifier(body, i) || body[i] === "?") return true;
  }
  return false;
}

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
  if (hasNestedQuantifier(source)) {
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
  // Truncated, not rejected: a long message should not silently stop matching,
  // and no realistic rule needs to look past the first few kilobytes.
  const subject = value.length > MAX_SUBJECT_LENGTH ? value.slice(0, MAX_SUBJECT_LENGTH) : value;
  const result = compiled.regex.exec(subject);
  const elapsed = performance.now() - began;

  if (elapsed > timeoutMs) {
    return { matched: false, captures: {}, timedOut: true };
  }
  if (result === null) return { matched: false, captures: {}, timedOut: false };

  return { matched: true, captures: { ...(result.groups ?? {}) }, timedOut: false };
}
