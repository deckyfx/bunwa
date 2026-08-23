/**
 * Rule evaluation.
 *
 * Pure: an event and a set of prepared rules in, a plan out. Nothing here
 * sends, writes or calls an engine — which is what makes the dry run honest,
 * because the dry run and the real path run exactly this code.
 */
import { runMatch, type CompiledPattern } from "./pattern";
import type { Action, Condition, PreparedRule } from "./schema";

/** How deep a chain of bunwa-caused events may go before it is cut. */
export const MAX_CHAIN_DEPTH = 3;

export interface EvaluationInput {
  event: Record<string, unknown>;
  rules: PreparedRule[];
  /** How many bunwa-caused events preceded this one. */
  chainDepth?: number;
  /** True when bunwa itself produced this event. */
  selfOriginated?: boolean;
}

export interface PlannedAction {
  ruleName: string;
  action: Action;
  /** Named captures from the rule that matched, for templating. */
  captures: Record<string, string>;
}

export interface Evaluation {
  actions: PlannedAction[];
  matched: string[];
  /**
   * Ids of rules whose pattern exceeded its budget.
   *
   * Ids, not names: the caller disables them, and a name cannot address a row.
   * Returning names meant the disable step could not be written at all, so the
   * budget was detected and then ignored.
   */
  timedOut: string[];
  /** Set when nothing ran, with the reason. */
  skipped?: "self_originated" | "chain_depth";
}

/**
 * Decide what a rule set does with an event.
 *
 * Two guards run before any rule is considered, and both are load-bearing: a
 * reply is itself a message, so without them a rule that answers a message
 * answers its own answer, for ever.
 */
export function evaluate(input: EvaluationInput): Evaluation {
  // Events bunwa caused are excluded by default. This is the difference between
  // a rule engine and a message loop.
  if (input.selfOriginated === true) {
    return { actions: [], matched: [], timedOut: [], skipped: "self_originated" };
  }
  if ((input.chainDepth ?? 0) >= MAX_CHAIN_DEPTH) {
    // Belt and braces: origin marking can be lost across an engine boundary,
    // and a depth cap holds even when it is.
    return { actions: [], matched: [], timedOut: [], skipped: "chain_depth" };
  }

  const actions: PlannedAction[] = [];
  const matched: string[] = [];
  const timedOut: string[] = [];

  const ordered = [...input.rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    const result = matchRule(rule, input.event);
    if (result.timedOut) {
      timedOut.push(rule.id);
      // A rule that cannot be evaluated in budget does not match. Treating a
      // timeout as a match would fire actions on an unknown condition.
      continue;
    }
    if (!result.matched) continue;

    matched.push(rule.name);
    for (const action of rule.actions) {
      actions.push({ ruleName: rule.name, action, captures: result.captures });
    }
    if (rule.stopOnMatch) break;
  }

  return { actions, matched, timedOut };
}

interface RuleMatch {
  matched: boolean;
  captures: Record<string, string>;
  timedOut: boolean;
}

function matchRule(rule: PreparedRule, event: Record<string, unknown>): RuleMatch {
  const captures: Record<string, string> = {};
  let timedOut = false;

  const check = (condition: Condition): boolean => {
    const outcome = test(condition, event, rule.compiled);
    if (outcome.timedOut) timedOut = true;
    Object.assign(captures, outcome.captures);
    return outcome.passed;
  };

  const all = rule.match.all ?? [];
  const any = rule.match.any ?? [];
  const none = rule.match.none ?? [];

  // Evaluated eagerly, not short-circuited. `every`/`some` stop at the first
  // decisive condition, so a later condition whose pattern blew its budget was
  // never run and never reported — the rule would quietly keep firing on a
  // partial evaluation.
  const allResults = all.map(check);
  const anyResults = any.map(check);
  const noneResults = none.map(check);

  const allPass = allResults.every(Boolean);
  const anyPass = any.length === 0 || anyResults.some(Boolean);
  const nonePass = none.length === 0 || !noneResults.some(Boolean);

  if (timedOut) return { matched: false, captures: {}, timedOut: true };
  return { matched: allPass && anyPass && nonePass, captures, timedOut: false };
}

interface ConditionResult {
  passed: boolean;
  captures: Record<string, string>;
  timedOut: boolean;
}

function test(
  condition: Condition,
  event: Record<string, unknown>,
  compiled: Map<string, CompiledPattern>,
): ConditionResult {
  const actual = readPath(event, condition.field);
  const none = { captures: {}, timedOut: false };

  switch (condition.op) {
    case "exists":
      return { passed: actual !== undefined && actual !== null, ...none };
    case "eq":
      return { passed: actual === condition.value, ...none };
    case "neq":
      return { passed: actual !== condition.value, ...none };
    case "in":
      return { passed: Array.isArray(condition.value) && condition.value.includes(actual), ...none };
    case "not_in":
      return { passed: !Array.isArray(condition.value) || !condition.value.includes(actual), ...none };
    case "contains":
      return { passed: asText(actual).includes(asText(condition.value)), ...none };
    case "starts_with":
      return { passed: asText(actual).startsWith(asText(condition.value)), ...none };
    case "ends_with":
      return { passed: asText(actual).endsWith(asText(condition.value)), ...none };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { passed: compare(condition.op, actual, condition.value), ...none };
    case "matches": {
      const pattern = compiled.get(`${condition.field}:${String(condition.value)}`);
      // A missing compiled pattern means the rule was not prepared. Failing
      // closed is right: firing on an unverified pattern is worse than not
      // firing.
      if (pattern === undefined) return { passed: false, captures: {}, timedOut: false };
      // Raw, not lowercased. Case sensitivity belongs to the pattern author —
      // folding the subject silently defeats `[A-Z]` and every other
      // case-bearing construct they wrote.
      const result = runMatch(pattern, typeof actual === "string" ? actual : String(actual ?? ""));
      return { passed: result.matched, captures: result.captures, timedOut: result.timedOut };
    }
  }
}

/**
 * Lowercased text, for the substring operators only.
 *
 * `contains "PAY"` matching "pay" is what an author expects from a plain
 * substring test. `matches` deliberately does not use this: a regex says what
 * it means about case, and folding its subject would override the author.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : String(value ?? "").toLowerCase();
}

function compare(op: "gt" | "gte" | "lt" | "lte", a: unknown, b: unknown): boolean {
  // Numbers first, then dates. Parsing "5" as a date gave NaN and made every
  // numeric comparison against a string silently false — a rule on a count or
  // a size would never fire and never say why.
  const left = toComparable(a);
  const right = toComparable(b);
  if (left === null || right === null) return false;
  // Comparing a date to a number is a rule that cannot mean anything sensible;
  // answering it would be worse than refusing.
  if (left.kind !== right.kind) return false;
  if (op === "gt") return left.value > right.value;
  if (op === "gte") return left.value >= right.value;
  if (op === "lt") return left.value < right.value;
  return left.value <= right.value;
}

/** A comparable value, tagged with what kind it is. */
interface Comparable {
  kind: "number" | "date";
  value: number;
}

/**
 * Interpret a value for ordering, keeping track of what it is.
 *
 * The kind matters. A date parses to a millisecond count, so comparing a
 * timestamp against the number 5 silently asks whether 1.7e12 > 5 and always
 * answers yes. Mismatched kinds now compare false rather than producing a
 * confident wrong answer.
 */
function toComparable(value: unknown): Comparable | null {
  if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", value } : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { kind: "date", value: value.getTime() };
  const text = String(value ?? "").trim();
  if (text === "") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return { kind: "number", value: Number(text) };
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : { kind: "date", value: parsed };
}

/**
 * Read a dotted path.
 *
 * Prototype keys are refused: a condition on `constructor.prototype` should
 * find nothing rather than reach into the runtime.
 */
function readPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return undefined;
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
